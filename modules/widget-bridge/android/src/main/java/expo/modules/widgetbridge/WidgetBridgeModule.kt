package expo.modules.widgetbridge

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WidgetBridgeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WidgetBridge")

    Function("setSharedData") { _: String, _: String, _: String ->
      // No-op on Android; Home/Lock Screen widgets are iOS-only for now.
    }

    Function("reloadWidgets") {
      // No-op on Android.
    }
  }
}
