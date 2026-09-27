export interface PlatformCredentialStatus {
  clientId: string | null;
  hasClientSecret: boolean;
}

/** Build the browser-safe credential DTO; never include the secret value. */
export function toPlatformCredentialStatus(
  clientId: string | null,
  clientSecret: string | null,
): PlatformCredentialStatus {
  return {
    clientId,
    hasClientSecret: Boolean(clientSecret),
  };
}
