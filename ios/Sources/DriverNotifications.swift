import Foundation
import UserNotifications

// Saved server events remain in the inbox until the driver explicitly reads them.
// Local alerts are checked while the active shift gives the app execution time.
final class DriverNotifications: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private var task: URLSessionDataTask?
    private var lastPoll = Date.distantPast
    private var generation = UUID()
    private var scope = ""
    private var seen = Set<String>()
    private var enabled = false

    func start(server: URL, driver: String) {
        stop()
        scope = "trip-notices:\(server.absoluteString):\(driver)"
        seen = Set(UserDefaults.standard.stringArray(forKey: scope) ?? [])
        center.delegate = self
        let current = generation
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] allowed, _ in
            DispatchQueue.main.async {
                guard let self, self.generation == current else { return }
                self.enabled = allowed
            }
        }
    }

    func stop() {
        generation = UUID()
        task?.cancel()
        task = nil
        enabled = false
        lastPoll = .distantPast
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
    }

    func poll(server: URL, token: String) {
        guard task == nil, Date().timeIntervalSince(lastPoll) >= 10 else { return }
        lastPoll = Date()
        let current = generation
        center.getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                guard let self, self.generation == current else { return }
                self.enabled = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            }
        }
        var request = URLRequest(url: server.appendingPathComponent("api/notifications"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15
        task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self, self.generation == current else { return }
                self.task = nil
                guard self.enabled, (response as? HTTPURLResponse)?.statusCode == 200,
                      let data, let payload = try? JSONDecoder().decode(Inbox.self, from: data) else { return }
                for event in payload.notifications where !self.seen.contains(event.id) {
                    let content = UNMutableNotificationContent()
                    content.title = event.kind == "assigned" ? "New trip assigned" : "Trip cancelled / unassigned"
                    content.body = "Open Dispatch to review your trip notifications."
                    content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: event.kind == "assigned" ? "assigned.wav" : "cancelled.wav"))
                    // Keep patient names, addresses and payment data off the lock screen.
                    let notice = UNNotificationRequest(identifier: event.id, content: content, trigger: nil)
                    self.seen.insert(event.id)
                    self.center.add(notice) { [weak self] error in
                        DispatchQueue.main.async {
                            guard let self, self.generation == current else { return }
                            if error != nil { self.seen.remove(event.id) }
                            UserDefaults.standard.set(Array(self.seen), forKey: self.scope)
                        }
                    }
                }
            }
        }
        task?.resume()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    private struct Inbox: Decodable { let notifications: [Event] }
    private struct Event: Decodable { let id: String; let kind: String }
}
