/**
 * Re-exports from @oh-my-pi/pi-ai.
 * All credential storage types and the AuthStorage class now live in the ai package.
 *
 * @deprecated Compatibility shim; import these names from `@oh-my-pi/pi-ai` (and
 * `SnapshotResponse` from `@oh-my-pi/pi-ai/auth-broker/types`). Will be removed in the next major.
 */

export type {
	ApiKeyCredential,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialStore,
	AuthStorageData,
	AuthStorageOptions,
	CredentialOrigin,
	CredentialOriginKind,
	OAuthAccountIdentity,
	OAuthAccountSummary,
	OAuthCredential,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	StoredAuthCredential,
} from "@oh-my-pi/pi-ai";
export { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
export type { SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker/types";
