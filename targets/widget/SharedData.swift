import Foundation

let widgetAppGroupId = "group.com.example.specialdatereminder"
let widgetDataKey = "widgetSyncPayload"
let widgetDeepLinkURL = URL(string: "remindmethis://open")

struct WidgetNextEvent: Codable {
    let title: String
    let people: String
    let dateLabel: String
}

struct WidgetNextReminder: Codable {
    let title: String
    let people: String
    let eventDateLabel: String
    let reminderDateLabel: String
}

struct WidgetSyncPayload: Codable {
    let nextEvent: WidgetNextEvent?
    let nextReminder: WidgetNextReminder?
    let updatedAt: String
}

enum WidgetSharedData {
    static func load() -> WidgetSyncPayload? {
        guard
            let defaults = UserDefaults(suiteName: widgetAppGroupId),
            let raw = defaults.string(forKey: widgetDataKey),
            let data = raw.data(using: .utf8)
        else {
            return nil
        }

        return try? JSONDecoder().decode(WidgetSyncPayload.self, from: data)
    }
}
