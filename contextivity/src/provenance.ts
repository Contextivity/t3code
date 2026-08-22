export type ProvenanceMode = "required" | "optional" | "unavailable";

export interface ProvenancePolicy {
  readonly checksumRequired: true;
  readonly privateSigningKey: "forbidden";
  readonly githubOidcAttestation: ProvenanceMode;
}

export function provenancePolicy(input: {
  readonly githubAuthenticated: boolean;
  readonly oidcAvailable: boolean;
}): ProvenancePolicy {
  const githubOidcAttestation: ProvenanceMode =
    input.githubAuthenticated && input.oidcAvailable
      ? "required"
      : input.githubAuthenticated
        ? "optional"
        : "unavailable";
  return {
    checksumRequired: true,
    privateSigningKey: "forbidden",
    githubOidcAttestation,
  };
}

export function assertNoPrivateSigningKey(env: Record<string, string | undefined>): void {
  const forbidden = [
    "CONTEXTIVITY_SIGNING_KEY",
    "CONTEXTIVITY_T3_SIGNING_KEY",
    "COSIGN_KEY",
    "COSIGN_PRIVATE_KEY",
  ];
  for (const name of forbidden) {
    if ((env[name] ?? "").trim() !== "") {
      throw new Error(
        `${name} is set. Downstream provenance uses GitHub OIDC attestations only; do not invent or store a private signing key.`,
      );
    }
  }
}

export function requireChecksumMatch(input: {
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly name: string;
}): void {
  if (input.expectedSha256.toLowerCase() !== input.actualSha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${input.name}: expected ${input.expectedSha256}, got ${input.actualSha256}.`,
    );
  }
}

export function shouldVerifyAttestation(policy: ProvenancePolicy): boolean {
  return policy.githubOidcAttestation === "required" || policy.githubOidcAttestation === "optional";
}

export function attestationVerifyArgs(input: {
  readonly artifactPath: string;
  readonly owner: string;
  readonly repo: string;
}): readonly string[] {
  return ["attestation", "verify", input.artifactPath, "--repo", `${input.owner}/${input.repo}`];
}
