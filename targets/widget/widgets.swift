import WidgetKit
import SwiftUI

private let widgetBrandColor = Color(red: 0x25 / 255, green: 0x63 / 255, blue: 0xeb / 255)

private extension View {
    @ViewBuilder
    func widgetBackground() -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(.fill.tertiary, for: .widget)
        } else {
            background(Color(.secondarySystemBackground))
        }
    }
}

struct RemindMeThisEntry: TimelineEntry {
    let date: Date
    let payload: WidgetSyncPayload?
}

struct RemindMeThisProvider: TimelineProvider {
    func placeholder(in context: Context) -> RemindMeThisEntry {
        RemindMeThisEntry(
            date: Date(),
            payload: WidgetSyncPayload(
                nextEvent: WidgetNextEvent(title: "Birthday", people: "Jordan", dateLabel: "Aug 19 at 9:00 AM"),
                nextReminder: WidgetNextReminder(title: "Birthday", people: "Jordan", eventDateLabel: "Aug 19", reminderDateLabel: "Aug 18 at 8:00 PM"),
                updatedAt: ""
            )
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (RemindMeThisEntry) -> Void) {
        completion(RemindMeThisEntry(date: Date(), payload: WidgetSharedData.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RemindMeThisEntry>) -> Void) {
        let entry = RemindMeThisEntry(date: Date(), payload: WidgetSharedData.load())
        let nextRefresh = Calendar.current.date(byAdding: .hour, value: 4, to: Date()) ?? Date().addingTimeInterval(4 * 60 * 60)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }
}

struct RemindMeThisWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    var entry: RemindMeThisProvider.Entry

    var body: some View {
        switch family {
        case .accessoryInline:
            inlineView
        case .accessoryRectangular:
            rectangularView
        case .systemMedium:
            mediumView
        default:
            smallView
        }
    }

    private var nextEventLine: String {
        guard let nextEvent = entry.payload?.nextEvent else {
            return "No scheduled events"
        }
        let who = nextEvent.people.isEmpty ? "" : " • \(nextEvent.people)"
        return "\(nextEvent.title)\(who) • \(nextEvent.dateLabel)"
    }

    private var nextReminderLine: String {
        guard let nextReminder = entry.payload?.nextReminder else {
            return "No scheduled reminders"
        }
        return "\(nextReminder.title) • \(nextReminder.reminderDateLabel)"
    }

    private var inlineView: some View {
        Label(entry.payload?.nextEvent != nil ? nextEventLine : nextReminderLine, systemImage: "bell.fill")
    }

    private var rectangularView: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Next Event")
                .font(.caption2)
                .fontWeight(.semibold)
            Text(nextEventLine)
                .font(.caption)
                .lineLimit(2)
        }
        .widgetAccentable()
    }

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Next Event", systemImage: "calendar")
                .font(.caption2)
                .fontWeight(.bold)
                .foregroundStyle(widgetBrandColor)

            Text(entry.payload?.nextEvent?.title ?? "No scheduled events")
                .font(.headline)
                .lineLimit(2)

            if let nextEvent = entry.payload?.nextEvent {
                Text(nextEvent.dateLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !nextEvent.people.isEmpty {
                    Text(nextEvent.people)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if let nextReminder = entry.payload?.nextReminder {
                Divider()
                Label("Reminder \(nextReminder.reminderDateLabel)", systemImage: "bell.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .widgetBackground()
        .widgetURL(widgetDeepLinkURL)
    }

    private var mediumView: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Label("Next Event", systemImage: "calendar")
                    .font(.caption2)
                    .fontWeight(.bold)
                    .foregroundStyle(widgetBrandColor)

                Text(entry.payload?.nextEvent?.title ?? "No scheduled events")
                    .font(.headline)
                    .lineLimit(2)

                if let nextEvent = entry.payload?.nextEvent {
                    Text(nextEvent.dateLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if !nextEvent.people.isEmpty {
                        Text(nextEvent.people)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Label("Next Reminder", systemImage: "bell.fill")
                    .font(.caption2)
                    .fontWeight(.bold)
                    .foregroundStyle(widgetBrandColor)

                Text(entry.payload?.nextReminder?.title ?? "No scheduled reminders")
                    .font(.headline)
                    .lineLimit(2)

                if let nextReminder = entry.payload?.nextReminder {
                    Text(nextReminder.reminderDateLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if !nextReminder.people.isEmpty {
                        Text(nextReminder.people)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .widgetBackground()
        .widgetURL(widgetDeepLinkURL)
    }
}

struct RemindMeThisWidget: Widget {
    let kind: String = "RemindMeThisWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: RemindMeThisProvider()) { entry in
            RemindMeThisWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Remind Me This")
        .description("See your next event and reminder at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
    }
}
