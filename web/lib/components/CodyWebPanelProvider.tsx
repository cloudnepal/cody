import {
    type FunctionComponent,
    type PropsWithChildren,
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import type { MessageConnection } from 'vscode-jsonrpc/browser'
import { URI } from 'vscode-uri'

import { hydrateAfterPostMessage, isErrorLike } from '@sourcegraph/cody-shared'
import type { ExtensionMessage } from 'cody-ai/src/chat/protocol'
import type { ChatExportResult } from 'cody-ai/src/jsonrpc/agent-protocol'
import { AppWrapper } from 'cody-ai/webviews/AppWrapper'
import { type VSCodeWrapper, setVSCodeWrapper } from 'cody-ai/webviews/utils/VSCodeApi'

import { createAgentClient } from '../agent/agent.client'
import type { InitialContext } from '../types'
import { useLocalStorage } from '../utils/use-local-storage'

/**
 * Local storage key for storing last active chat id, preserving
 * chat id in the local storage allows us to restore the last active chat
 * as you open/render Cody Web.
 */
const ACTIVE_CHAT_ID_KEY = 'cody-web.last-active-chat-id'

// Usually the CodyWebPanelProvider VSCode API wrapper listens only to messages from the Extension host
// which matches the current active panel id. But this message id check can be corrupted
// by race conditions in different events that the extension host sends during chat-switching.
// Some events should always be handled by the client regardless of which active panel they
// came from.
const GLOBAL_MESSAGE_TYPES: Array<ExtensionMessage['type']> = ['rpc/response']

interface AgentClient {
    rpc: MessageConnection
    dispose(): void
}

interface CodyWebPanelContextData {
    client: AgentClient | Error | null
    activeChatID: string | null
    activeWebviewPanelID: string
    vscodeAPI: VSCodeWrapper
    initialContext: InitialContext | undefined
    setLastActiveChatID: (chatID: string | null) => void
    createChat: () => Promise<void>
    selectChat: (chat: ChatExportResult) => Promise<void>
}

export const CodyWebPanelContext = createContext<CodyWebPanelContextData>({
    client: null,
    activeChatID: null,
    activeWebviewPanelID: '',
    initialContext: undefined,

    // Null casting is just to avoid unnecessary null type checks in
    // consumers, CodyWebPanelProvider creates graphQL vscodeAPI and graphql client
    // unconditionally, so this is safe to provide null as a default value here
    vscodeAPI: null as any,
    setLastActiveChatID: () => {},
    createChat: () => Promise.resolve(),
    selectChat: () => Promise.resolve(),
})

interface CodyWebPanelProviderProps {
    serverEndpoint: string
    accessToken: string | null
    chatID?: string | null
    telemetryClientName?: string
    initialContext?: InitialContext
    customHeaders?: Record<string, string>
    onNewChatCreated?: (chatId: string) => void
}

/**
 * The root store/provider node for Cody Web, creates and shares
 * agent client and maintains active web panel ID, chat history and vscodeAPI.
 */
export const CodyWebPanelProvider: FunctionComponent<PropsWithChildren<CodyWebPanelProviderProps>> = ({
    serverEndpoint,
    accessToken,
    initialContext,
    telemetryClientName,
    children,
    chatID: initialChatId,
    customHeaders,
    onNewChatCreated,
}) => {
    // In order to avoid multiple client creation during dev runs
    // since useEffect can be fired multiple times during dev builds
    const isClientInitialized = useRef(false)
    const activeWebviewPanelIDRef = useRef<string>('')
    const onMessageCallbacksRef = useRef<((message: ExtensionMessage) => void)[]>([])

    const [activeWebviewPanelID, setActiveWebviewPanelID] = useState<string>('')
    const [client, setClient] = useState<AgentClient | Error | null>(null)
    const [lastActiveChatID, setLastActiveChatID] = useLocalStorage<string | null>(
        ACTIVE_CHAT_ID_KEY,
        null
    )

    activeWebviewPanelIDRef.current = activeWebviewPanelID

    // TODO [VK] Memoize agent client creation to avoid re-creating client
    useEffect(() => {
        ;(async () => {
            if (isClientInitialized.current) {
                return
            }

            isClientInitialized.current = true

            try {
                const client = await createAgentClient({
                    customHeaders,
                    telemetryClientName,
                    workspaceRootUri: '',
                    serverEndpoint: serverEndpoint,
                    accessToken: accessToken ?? '',
                })

                // Fetch existing chats from the agent chat storage
                const chatHistory = await client.rpc.sendRequest<ChatExportResult[]>('chat/export', {
                    fullHistory: true,
                })

                const initialChat = chatHistory.find(chat => chat.chatID === initialChatId)

                // In case of no chats we should create initial empty chat
                // Also when we have a context
                if (chatHistory.length === 0 || (initialChatId !== undefined && !initialChat)) {
                    await createChat(client)
                } else {
                    // Activate either last active chat by ID from local storage or
                    // set the last created chat from the history
                    const lastUsedChat = chatHistory.find(chat => chat.chatID === lastActiveChatID)
                    const lastActiveChat =
                        initialChat ?? lastUsedChat ?? chatHistory[chatHistory.length - 1]

                    await selectChat(lastActiveChat, client)
                }

                setClient(client)
            } catch (error) {
                console.error(error)
                setClient(() => error as Error)
            }
        })()
    }, [
        initialChatId,
        accessToken,
        serverEndpoint,
        lastActiveChatID,
        customHeaders,
        telemetryClientName,
    ])

    const createChat = useCallback(
        async (agent = client) => {
            if (!agent || isErrorLike(agent)) {
                return
            }

            const { panelId, chatId } = await agent.rpc.sendRequest<{
                panelId: string
                chatId: string
            }>('chat/web/new')

            activeWebviewPanelIDRef.current = panelId

            setActiveWebviewPanelID(panelId)
            setLastActiveChatID(chatId)

            await agent.rpc.sendRequest('webview/receiveMessage', {
                id: activeWebviewPanelIDRef.current,
                message: { chatID: chatId, command: 'restoreHistory' },
            })

            // Set initial context after we restore history so context won't be
            // overridden by the previous chat session context
            if (initialContext?.repositories.length) {
                await agent.rpc.sendRequest('webview/receiveMessage', {
                    id: activeWebviewPanelIDRef.current,
                    message: {
                        command: 'context/choose-remote-search-repo',
                        explicitRepos: initialContext?.repositories ?? [],
                    },
                })
            }

            if (onNewChatCreated) {
                onNewChatCreated(chatId)
            }
        },
        [client, onNewChatCreated, setLastActiveChatID, initialContext]
    )

    const vscodeAPI = useMemo<VSCodeWrapper>(() => {
        if (client && !isErrorLike(client)) {
            client.rpc.onNotification(
                'webview/postMessage',
                ({ id, message }: { id: string; message: ExtensionMessage }) => {
                    if (
                        activeWebviewPanelIDRef.current === id ||
                        GLOBAL_MESSAGE_TYPES.includes(message.type)
                    ) {
                        for (const callback of onMessageCallbacksRef.current) {
                            callback(hydrateAfterPostMessage(message, uri => URI.from(uri as any)))
                        }
                    }
                }
            )
        }
        const vscodeAPI: VSCodeWrapper = {
            postMessage: message => {
                if (client && !isErrorLike(client)) {
                    if (message.command === 'command' && message.id === 'cody.chat.new') {
                        void createChat(client)
                        return
                    }
                    void client.rpc.sendRequest('webview/receiveMessage', {
                        id: activeWebviewPanelIDRef.current,
                        message,
                    })
                }
            },
            onMessage: callback => {
                if (client && !isErrorLike(client)) {
                    onMessageCallbacksRef.current.push(callback)
                    return () => {
                        // Remove callback from onMessageCallbacks.
                        const index = onMessageCallbacksRef.current.indexOf(callback)
                        if (index >= 0) {
                            onMessageCallbacksRef.current.splice(index, 1)
                        }
                    }
                }
                return () => {}
            },
            getState: () => {
                throw new Error('not implemented')
            },
            setState: () => {
                throw new Error('not implemented')
            },
        }

        // Runtime sync side effect, ensure that later any cody UI
        // components will have access to the mocked/synthetic VSCode API
        setVSCodeWrapper(vscodeAPI)
        return vscodeAPI
    }, [client, createChat])

    const selectChat = useCallback(
        async (chat: ChatExportResult, agent = client) => {
            if (!agent || isErrorLike(agent)) {
                return
            }

            // Notify main root provider about chat selection
            setLastActiveChatID(chat.chatID)

            // Restore chat with chat history (transcript data) and set the newly
            // restored panel ID to be able to listen event from only this panel
            // in the vscode API
            const nextPanelId = await agent.rpc.sendRequest<string>('chat/restore', {
                chatID: chat.chatID,
                messages: chat.transcript.interactions.flatMap(interaction =>
                    // Ignore incomplete messages from bot, this might be possible
                    // if chat was closed before LLM responded with a final message chunk
                    [interaction.humanMessage, interaction.assistantMessage].filter(message => message)
                ),
            })
            activeWebviewPanelIDRef.current = nextPanelId
            setActiveWebviewPanelID(nextPanelId)

            // Make sure that agent will reset the internal state and
            // sends all necessary events with transcript to switch active chat
            vscodeAPI.postMessage({ chatID: chat.chatID, command: 'restoreHistory' })
        },
        [client, vscodeAPI, setLastActiveChatID]
    )

    const contextInfo = useMemo(
        () => ({
            client,
            vscodeAPI,
            activeWebviewPanelID,
            activeChatID: lastActiveChatID,
            setLastActiveChatID,
            initialContext,
            createChat,
            selectChat,
        }),
        [
            client,
            vscodeAPI,
            activeWebviewPanelID,
            lastActiveChatID,
            setLastActiveChatID,
            initialContext,
            createChat,
            selectChat,
        ]
    )

    return (
        <AppWrapper>
            <CodyWebPanelContext.Provider value={contextInfo}>{children}</CodyWebPanelContext.Provider>
        </AppWrapper>
    )
}

export function useWebAgentClient(): CodyWebPanelContextData {
    return useContext(CodyWebPanelContext)
}
