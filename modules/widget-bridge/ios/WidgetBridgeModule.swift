import ExpoModulesCore
import WidgetKit

public class WidgetBridgeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WidgetBridge")

    Function("setSharedData") { (appGroupId: String, key: String, json: String) in
      UserDefaults(suiteName: appGroupId)?.set(json, forKey: key)
    }

    Function("reloadWidgets") { () in
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
