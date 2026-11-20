import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Config } from '../config.ts';
import type { UserDoc } from '../db/types.ts';

/** The two calls that need a real authenticator's output; tests replace them. */
export interface PasskeyVerifiers {
  verifyReg: typeof verifyRegistrationResponse;
  verifyAuth: typeof verifyAuthenticationResponse;
}

export const realVerifiers: PasskeyVerifiers = {
  verifyReg: verifyRegistrationResponse,
  verifyAuth: verifyAuthenticationResponse,
};

/** Challenges (and so the options that carry them) live for 5 minutes. */
export const CHALLENGE_TTL_MS = 5 * 60_000;

type StoredPasskey = NonNullable<UserDoc['passkeys']>[number];
export type NewPasskey = Pick<StoredPasskey, 'credentialId' | 'publicKey' | 'counter' | 'transports'>;

/** WebAuthn ceremonies for one relying party (rpID and origin come from config); `deps` supplies the verifiers. */
export function createPasskeys(config: Config, deps: PasskeyVerifiers = realVerifiers) {
  const rp = { expectedOrigin: config.appOrigin, expectedRPID: config.webauthnRpId };

  return {
    registrationOptions(user: Pick<UserDoc, '_id' | 'email' | 'name' | 'passkeys'>): Promise<PublicKeyCredentialCreationOptionsJSON> {
      return generateRegistrationOptions({
        rpName: config.webauthnRpName,
        rpID: config.webauthnRpId,
        userName: user.email,
        userDisplayName: user.name,
        userID: new TextEncoder().encode(user._id),
        excludeCredentials: (user.passkeys ?? []).map((p) => ({ id: p.credentialId, transports: p.transports })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
    },

    /** The new passkey's fields, or null when the authenticator's answer does not check out. */
    async verifyRegistration(response: unknown, expectedChallenge: string): Promise<NewPasskey | null> {
      try {
        const result = await deps.verifyReg({
          response: response as RegistrationResponseJSON,
          expectedChallenge,
          ...rp,
          requireUserVerification: true,
        });
        if (!result.verified) return null;
        const { credential } = result.registrationInfo;
        const sent = (response as RegistrationResponseJSON).response?.transports;
        return {
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          transports: sent ?? credential.transports ?? [],
        };
      } catch {
        return null;
      }
    },

    /** Without `allowCredentials` the browser offers any discoverable credential (passwordless). */
    authenticationOptions(passkeys?: StoredPasskey[]): Promise<PublicKeyCredentialRequestOptionsJSON> {
      return generateAuthenticationOptions({
        rpID: config.webauthnRpId,
        userVerification: 'required',
        ...(passkeys ? { allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })) } : {}),
      });
    },

    /** The new signature counter, or null when verification fails (including a counter that went backwards). */
    async verifyAuthentication(
      response: unknown,
      expectedChallenge: string,
      passkey: StoredPasskey,
    ): Promise<number | null> {
      try {
        const result = await deps.verifyAuth({
          response: response as AuthenticationResponseJSON,
          expectedChallenge,
          ...rp,
          requireUserVerification: true,
          credential: {
            id: passkey.credentialId,
            publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
            counter: passkey.counter,
            transports: passkey.transports,
          },
        });
        return result.verified ? result.authenticationInfo.newCounter : null;
      } catch {
        return null;
      }
    },
  };
}

export type Passkeys = ReturnType<typeof createPasskeys>;
