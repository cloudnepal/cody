@file:Suppress("FunctionName", "ClassName", "unused", "EnumEntryName", "UnusedImport")
package com.sourcegraph.cody.agent.protocol_generated;

data class ExecuteCommandParams(
  val command: String,
  val arguments: List<Any>? = null,
)
