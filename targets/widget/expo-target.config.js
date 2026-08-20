/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = config => ({
  type: "widget",
  name: "RemindMeThisWidget",
  displayName: "Remind Me This",
  colors: {
    $accent: "#2563eb",
    $widgetBackground: "#f5f7ff",
  },
  frameworks: ["SwiftUI", "WidgetKit"],
  deploymentTarget: "16.0",
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});