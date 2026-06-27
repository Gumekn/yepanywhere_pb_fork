# Push Notifications Troubleshooting

Push notifications allow Yep Anywhere to alert you when a session needs attention, even when the app is in the background or your phone is locked.

## Requirements

Push notifications require:

1. **HTTPS** - Service workers only work over secure connections (or localhost)
2. **Service Worker Support** - Modern browsers (Chrome, Firefox, Safari 16+, Edge)
3. **PushManager API** - Not available in all browsers (notably older Safari versions)
4. **Notification Permission** - User must grant permission when prompted

## Android APK Native Push

The Android APK uses Firebase Cloud Messaging for reliable system
notifications. Browser Web Push remains available for Chrome/PWA clients.

Required private configuration:

1. Add the Android Firebase config at:
   `packages/mobile/src-tauri/gen/android/app/google-services.json`
2. Provide server FCM credentials with one of:
   - `YEP_FCM_SERVICE_ACCOUNT_FILE=/path/to/firebase-service-account.json`
   - `YEP_FCM_SERVICE_ACCOUNT_JSON='{"project_id":...}'`
   - `GOOGLE_APPLICATION_CREDENTIALS=/path/to/firebase-service-account.json`

Both files are ignored by git. Without `google-services.json`, the APK still
builds but native token registration is unavailable. Without server FCM
credentials, native devices can be listed locally but test and session push
delivery fail with a configuration error.

If the server is managed by the macOS LaunchAgent, persist the FCM credential
there before redeploying:

```bash
YEP_FCM_SERVICE_ACCOUNT_FILE=/path/to/firebase-service-account.json scripts/install-launchagents.sh --server-only
```

This reloads only the 8022 server LaunchAgent. Use `--no-start` only when you
want to write the plist without changing the currently running service; the new
environment will not be active until the LaunchAgent is loaded again.

`scripts/deploy.sh` checks both native push prerequisites. Missing config is a
warning by default, or a hard failure with:

```bash
YEP_REQUIRE_NATIVE_PUSH=true scripts/deploy.sh
```

### Android 16 compatibility notes

- The APK targets API 36. Android notification permission is still handled with
  `POST_NOTIFICATIONS` on Android 13+; the app tracks whether the permission was
  already requested so Settings can distinguish first-run from blocked state.
- Native FCM sends both `notification` and `data` payloads. Android can show the
  notification from the system tray while the app is backgrounded, and the data
  payload still carries `projectId` / `sessionId` for click navigation.
- Android 16 introduces Local Network Protection as an opt-in preview. The APK
  declares `NEARBY_WIFI_DEVICES` with `neverForLocation` so future LAN/WebView
  compatibility work has the required manifest permission in place.

## Common Issues

### "Push notifications are not supported in this browser"

This can happen for several reasons:

1. **Development Mode** - Service workers are disabled by default in dev mode to avoid page reload issues. Set `VITE_ENABLE_SW=true` in your environment to enable them.

2. **HTTP Connection** - Service workers require HTTPS. Use a reverse proxy with TLS termination.

3. **Unsupported Browser** - Some browsers don't support the Push API:
   - Safari < 16 on iOS
   - Some privacy-focused browsers
   - Browsers in private/incognito mode

4. **Service Worker Blocked by Auth** - If you're using basic auth with a reverse proxy, the service worker file (`sw.js`) must be accessible without authentication. See the Caddy configuration example below.

### Service Worker Registration Fails

Check the browser console for errors. Common causes:

- `sw.js` returns a 401/403 (blocked by auth)
- `sw.js` returns wrong MIME type (must be `application/javascript`)
- Mixed content (loading HTTP resources from HTTPS page)

## Reverse Proxy Configuration

When using a reverse proxy with basic auth, you must exclude PWA files from authentication. The service worker and manifest must be publicly accessible for the browser to register them.

### Caddy Example

```caddyfile
example.com {
    # PWA files must be accessible without auth
    @pwa_public {
        path /manifest.json /sw.js /icon-*.png /favicon.ico /badge-*.png
    }
    handle @pwa_public {
        reverse_proxy 127.0.0.1:3400
    }

    # Everything else requires auth
    handle {
        basicauth {
            username $2a$14$hashedpasswordhere
        }
        reverse_proxy 127.0.0.1:3400
    }
}
```

### nginx Example

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    # PWA files - no auth required
    location ~ ^/(manifest\.json|sw\.js|icon-.*\.png|favicon\.ico|badge-.*\.png)$ {
        proxy_pass http://127.0.0.1:3400;
    }

    # Everything else requires auth
    location / {
        auth_basic "Restricted";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:3400;
    }
}
```

## Testing Push Notifications

1. Go to **Settings > Notifications** in Yep Anywhere
2. Enable **Push Notifications** (you'll be prompted for permission)
3. Click **Send Test** to verify the notification arrives

If the test notification doesn't appear:

- Check that notifications are enabled in your OS settings
- Check that the browser has notification permission for this site
- Look for errors in the browser console
- Check server logs for push delivery errors

## Still Having Issues?

Open an issue on GitHub with:

- Browser and version
- Operating system
- Any errors from the browser console
- Server logs if available

[Report an Issue](https://github.com/kzahel/yepanywhere/issues)
