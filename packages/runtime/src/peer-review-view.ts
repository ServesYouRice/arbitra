import type { ReviewRng } from "@arbitra/workflow/nodes/peer-review/round.js";
import type { AuditFinding } from "./auditors.js";
import type { ConsensusCandidate } from "@arbitra/workflow/consensus/engine.js";

/** Anonymous transport view. The reverse map stays outside the model's context. */
export function peerReviewView(candidateIds: readonly string[], findings: Readonly<Record<string, readonly AuditFinding[]>>, reviewerId: string, rng: ReviewRng, board?: Readonly<Record<string, ConsensusCandidate>>) {
  const evidenceIds = new Map<string, string>();
  const findingIds = new Map<string, string>();
  const locationIdsByAlias = new Map<string, string>();
  const authorOf = (finding: AuditFinding) => finding.sourceFindingId.split("/", 1)[0] ?? "";
  const authors = rng.shuffle([...new Set(candidateIds.flatMap((id) => (findings[id] ?? []).map(authorOf)).filter((author) => author !== reviewerId))]);
  const labels = new Map(authors.map((author, index) => [author, `Peer ${index + 1}`]));
  const views = candidateIds.flatMap((candidateId) => {
    const counterEvidenceIds = new Set((board?.[candidateId]?.counterEvidence ?? []).flatMap((entry) => typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string" ? [entry.id] : []));
    const peers = rng.shuffle([...(findings[candidateId] ?? [])].filter(({ sourceFindingId }) => !sourceFindingId.startsWith(`${reviewerId}/`)));
    const lead = peers[0];
    if (lead === undefined) return [];
    const sources = peers.map((finding, index) => {
      const prefix = `${candidateId}/source-${index + 1}`;
      findingIds.set(prefix, finding.sourceFindingId);
      const locations = finding.locations.map((location, locationIndex) => ({ ...location, id: `${prefix}/location-${locationIndex + 1}` }));
      for (const [locationIndex, location] of finding.locations.entries()) {
        const alias = locations[locationIndex]?.id;
        if (alias !== undefined) locationIdsByAlias.set(alias, location.id);
      }
      const locationIds = new Map(finding.locations.map(({ id }, locationIndex) => [id, locations[locationIndex]?.id]));
      const evidence = finding.evidence.map((entry, evidenceIndex) => {
        const id = `${prefix}/evidence-${evidenceIndex + 1}`;
        evidenceIds.set(id, entry.id);
        return { id, text: entry.text, stance: counterEvidenceIds.has(entry.id) ? "counter" : "support", locationIds: entry.locationIds.map((locationId) => {
          const alias = locationIds.get(locationId);
          if (alias === undefined) throw new Error("PEER_EVIDENCE_LOCATION_ABSENT");
          return alias;
        }) };
      });
      // Do not spread the finding: model-authored extensions and original IDs can
      // reveal its author, and the review does not need that provenance.
      return { findingRef: prefix, label: labels.get(authorOf(finding)), title: finding.title, problem: finding.problem, recommendedFix: finding.recommendedFix, locations, evidence };
    });
    const current = board?.[candidateId];
    return [{ candidateId, claim: current?.claim ?? { title: lead.title, description: lead.problem }, severity: current?.severity ?? lead.severity, blocker: current?.blocker ?? lead.productionBlocker, sources }];
  });
  return { candidates: Object.fromEntries(views.map((view) => [view.candidateId, view])), evidenceIds, findingIds, locationIds: locationIdsByAlias };
}
