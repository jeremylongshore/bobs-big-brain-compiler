# Bob’s Big Brain consumer notice

This is a local supplement to the unmodified upstream audit-harness v1.5.1
payloads. It is not part of that upstream release. `BBB-SOURCE.json` records the
selected source commit, installer, observed archive digest, all 50 copied payload
hashes and generated output hashes. A fresh offline installation was compared
against these files; only the generated installation timestamp is excluded from
that comparison. These co-located records are not an independent witness or a
signed attestation. A later installer invocation replaces the vendor directory;
regenerate and review these supplements when updating it.

## Authority and limits

The stock README, schemas and changelog describe the upstream project. Their
policy names, estate directives, partner/sponsorship links, CI gate descriptions
and historical release claims do not establish Bob’s Brain policy, sponsorship,
installed CI coverage, production status or adoption of additional contracts.
Bob’s Brain repository instructions and owning contracts remain authoritative.

Hash verification reports mismatch against the selected manifest when executed.
It does not prevent files, manifests or the verifier from being changed together,
or independently enforce review of a re-pin. Local Brain audit guarantees remain
tamper-evident: integrity, ordering and rewrite detection within the stated trust
boundary. Historical upstream registry and Rekor wording is not a stronger local
Brain guarantee; a local submission queue is distinct from a transparency log.

Marketplace conformance claims here are limited to the encoded structural checks;
this update does not establish complete semantic validation. The v0.10.0 evidence
snapshot and v0.11.0 authoring projection address separate upstream contracts.
Audit-profile gate resolution and a full timestamped profile are different:
no whole-profile byte determinism is asserted by this consumer. The snapshot’s
hash in upstream PROVENANCE is distinct from the consumer .harness-hash manifest.

## Known upstream qualifications

Upstream release-history and allowed-tools prose contain inconsistencies; this
consumer does not choose one conflicting statement as policy. The source commit
and file hashes identify the selected bytes independently of those descriptions.

The Node CLI’s configured timeout signals only its immediate child in v1.5.1;
a descendant can continue after a timeout. Timeout124 is not proof all descendants
stopped. The proposed owning-source correction and regression tests are in
[upstream PR223](https://github.com/jeremylongshore/intent-audit-harness/pull/223).
It does not change these selected v1.5.1 payloads or establish a published fix.
No timeout supervision is claimed for the separate generated shell wrapper.
