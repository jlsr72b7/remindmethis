import { NativeModule, requireNativeModule } from 'expo';

declare class WidgetBridgeModule extends NativeModule<{}> {
  setSharedData(appGroupId: string, key: string, json: string): void;
  reloadWidgets(): void;
}

export default requireNativeModule<WidgetBridgeModule>('WidgetBridge');
