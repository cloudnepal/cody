import * as vscode from 'vscode'

import {
    type ContextItem,
    type EditModel,
    type EventSource,
    type PromptString,
    ps,
} from '@sourcegraph/cody-shared'

import type { EditIntent, EditMode } from '../edit/types'

import type { FixupFile } from './FixupFile'
import type { Edit } from './line-diff'
import { CodyTaskState } from './utils'

export type FixupTaskID = string

/**
 * Arbitrary metadata that will be included in telemetry events for this task.
 */
export type FixupTelemetryMetadata = {
    [key: string]: unknown
}

export class FixupTask {
    public id: FixupTaskID
    public state_: CodyTaskState = CodyTaskState.Idle
    private stateChanges = new vscode.EventEmitter<CodyTaskState>()
    public onDidStateChange = this.stateChanges.event
    /**
     * The original text that we're working on updating. Set when we start an LLM spin.
     */
    public original = ''
    /**
     * The original range that we're working on updating.
     * Used to perform an accurate retry. We cannot use `selectionRange` as that range may expand with the replacement code.
     */
    public originalRange: vscode.Range
    /** The text of the streaming turn of the LLM, if any */
    public inProgressReplacement: string | undefined
    /** The text of the last completed turn of the LLM, if any */
    public replacement: string | undefined
    /** The error attached to the fixup, if any */
    public error: Error | undefined
    /**
     * If text has been received from the LLM and a diff has been computed,
     * it is cached here. Diffs are recomputed lazily and may be stale.
     */
    public diff: Edit[] | undefined
    /** The number of times we've submitted this to the LLM. */
    public spinCount = 0

    constructor(
        /**
         * The file that will be updated by Cody with the replacement text at the end of stream
         * This is set by the FixupController when creating the task,
         * and will be updated by the FixupController for tasks using the 'new' mode
         */
        public fixupFile: FixupFile,
        public document: vscode.TextDocument,
        public readonly instruction: PromptString,
        public readonly userContextItems: ContextItem[],
        /* The intent of the edit, derived from the source of the command. */
        public readonly intent: EditIntent,
        /* The range being edited. This range is tracked and updates as the user (or Cody) edits code. */
        public selectionRange: vscode.Range,
        /* The mode indicates how code should be inserted */
        public readonly mode: EditMode,
        public readonly model: EditModel,
        /* the source of the instruction, e.g. 'code-action', 'doc', etc */
        public source?: EventSource,
        /* The file to write the edit to. If not provided, the edit will be applied to the fixupFile. */
        public destinationFile?: vscode.Uri,
        /* The position where the Edit should start. Defaults to the start of the selection range. */
        public insertionPoint: vscode.Position = selectionRange.start,
        public readonly telemetryMetadata: FixupTelemetryMetadata = {}
    ) {
        this.id = Date.now().toString(36).replaceAll(/\d+/g, '')
        this.instruction = instruction.replace(/^\/(edit|fix)/, ps``).trim()
        // We always expand the range to encompass all characters from the selection lines
        // This is so we can calculate an optimal diff, and the LLM has the best chance at understanding
        // the indentation in the returned code.
        this.selectionRange = new vscode.Range(
            selectionRange.start.line,
            0,
            selectionRange.end.line,
            document.lineAt(selectionRange.end.line).range.end.character
        )
        this.originalRange = this.selectionRange
    }

    /**
     * Sets the task state. Checks the state transition is valid.
     */
    public set state(state: CodyTaskState) {
        if (state === CodyTaskState.Error) {
            console.log(new Error().stack)
        }
        this.state_ = state
        this.stateChanges.fire(state)
    }

    /**
     * Gets the state of the fixup task.
     *
     * @returns The current state of the fixup task.
     */
    public get state(): CodyTaskState {
        return this.state_
    }
}
