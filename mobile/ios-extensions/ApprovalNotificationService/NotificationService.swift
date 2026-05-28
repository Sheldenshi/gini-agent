// Notification Service Extension for the Gini iOS app.
//
// Triggered by APNs payloads with `mutable-content: 1` so the OS gives
// us ~30 seconds to mutate the notification before display. For the
// approval-requested flow we just attach the `APPROVAL_REQUEST`
// category id, which is what lets the lock-screen / banner show the
// inline Approve / Deny action buttons the main app registered via
// `Notifications.setNotificationCategoryAsync`.
//
// Standard fallback: if anything fails or the payload isn't in our
// shape, call `contentHandler` with the original content unchanged.
// iOS treats that as "show the alert as-sent" — the user still sees
// the notification, just without the inline actions.

import UserNotifications

class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        self.bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let bestAttempt = bestAttemptContent else {
            // Couldn't get a mutable copy — fall through to the unchanged
            // content. The OS will still surface the alert.
            contentHandler(request.content)
            return
        }

        // Inspect the custom data block the dispatcher sets. We only
        // attach the approval category for the approval_requested
        // event so a future expansion (other actionable categories)
        // can branch here without affecting unrelated push types.
        let event = bestAttempt.userInfo["event"] as? String
        if event == "approval_requested" {
            bestAttempt.categoryIdentifier = "APPROVAL_REQUEST"
        }

        contentHandler(bestAttempt)
    }

    override func serviceExtensionTimeWillExpire() {
        // iOS calls this if the 30s window expires before we returned.
        // Hand back whatever we'd assembled so far — better the user
        // sees a category-less alert than nothing at all.
        if let contentHandler = contentHandler, let bestAttempt = bestAttemptContent {
            contentHandler(bestAttempt)
        }
    }
}
