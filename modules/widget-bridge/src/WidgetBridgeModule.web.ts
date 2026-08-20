import { registerWebModule, NativeModule } from 'expo';

class WidgetBridgeModule extends NativeModule<{}> {
  setSharedData(_appGroupId: string, _key: string, _json: string) {}
  reloadWidgets() {}
}

export default registerWebModule(WidgetBridgeModule, 'WidgetBridgeModule');
