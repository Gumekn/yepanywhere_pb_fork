# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Keep Android WebView JavaScript bridge methods callable in release builds.
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations
-keepclassmembers class * {
  @android.webkit.JavascriptInterface <methods>;
}
-keep class com.yepanywhere.mobile.local.MainActivity$NativePushBridge {
  public *;
}
-keep class com.yepanywhere.mobile.local.YepFirebaseMessagingService {
  public *;
}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
