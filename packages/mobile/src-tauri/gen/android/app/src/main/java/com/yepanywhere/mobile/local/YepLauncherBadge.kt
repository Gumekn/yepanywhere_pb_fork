package com.yepanywhere.mobile.local

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log

object YepLauncherBadge {
  private const val TAG = "YepNativePush"

  fun sync(context: Context, count: Int) {
    val normalizedCount = count.coerceAtLeast(0)
    Log.i(TAG, "badge.sync: count=$normalizedCount")
    syncXiaomi(context, normalizedCount)
  }

  private fun syncXiaomi(context: Context, count: Int) {
    try {
      val component = ComponentName(context, MainActivity::class.java)
      val intent = Intent("android.intent.action.APPLICATION_MESSAGE_UPDATE")
        .putExtra(
          "android.intent.extra.update_application_component_name",
          component.flattenToString(),
        )
        .putExtra(
          "android.intent.extra.update_application_message_text",
          if (count > 0) count.toString() else "",
        )
      context.sendBroadcast(intent)
    } catch (error: RuntimeException) {
      Log.d(TAG, "badge.syncXiaomi: failed ${error.javaClass.simpleName}: ${error.message}")
    }
  }
}
