package com.yepanywhere.mobile.local

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // With enableEdgeToEdge() the system bars + IME no longer auto-resize
    // the activity, even with android:windowSoftInputMode="adjustResize"
    // declared in the manifest. Without explicit insets handling, opening
    // the soft keyboard pans the whole window upward — which on edge-to-
    // edge looks like the page slides under the status bar.
    //
    // Apply ONLY the keyboard (IME) inset as bottom padding on the root.
    // Status-bar and gesture-nav insets are already handled in CSS via
    // env(safe-area-inset-top / -bottom); doubling that up here would
    // leave a visible gap.
    val rootView = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      // IME inset already includes the system bar height at the bottom
      // when keyboard is up — subtract it so we don't double-pad against
      // CSS's env(safe-area-inset-bottom).
      val keyboardOnlyBottom = (ime.bottom - systemBars.bottom).coerceAtLeast(0)
      view.setPadding(0, 0, 0, keyboardOnlyBottom)
      insets
    }
  }
}
