declare const resourceKeyBrand: unique symbol;

/** Backend-private resource correlation key; it is not an Appium Session or service identifier. */
export type ResourceKey = string & { readonly [resourceKeyBrand]: true };

export type ResourceOwnership =
  | Readonly<{
      state: 'maat-owned';
      resource: ResourceKey;
      proof: 'owner-token' | 'child-process-token';
    }>
  | Readonly<{ state: 'externally-managed'; manager: 'user' | 'appium' | 'provider' }>
  | Readonly<{ state: 'uncertain'; reasonCode: string }>;

export type MobileResourceOwnership = Readonly<{
  appiumService: ResourceOwnership;
  appiumSession: ResourceOwnership;
  automationBackend: ResourceOwnership;
}>;
