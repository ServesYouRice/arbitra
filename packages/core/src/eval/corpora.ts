import type { IndependenceObservation, RealWorldOutcomeObservation } from "@arbitra/schemas/evaluation-corpus.js";

export type { IndependenceObservation, OutcomeState, RealWorldOutcomeObservation } from "@arbitra/schemas/evaluation-corpus.js";

/**
 * Corpus store contracts. The in-memory implementations below serve tests and ephemeral
 * callers; the durable implementations (`DurableRealWorldOutcomeStore`,
 * `DurableIndependenceCorpusStore`) live in `packages/persistence/src/evaluation-corpus/`
 * and satisfy these interfaces structurally, because persistence sits below core.
 */
export interface RealWorldOutcomeStore {
  append(observation: RealWorldOutcomeObservation): Promise<void>;
  query(runIds?: readonly string[]): Promise<readonly RealWorldOutcomeObservation[]>;
}

export interface IndependenceCorpusStore {
  append(observation: IndependenceObservation): Promise<void>;
  query(runIds?: readonly string[]): Promise<readonly IndependenceObservation[]>;
}

export class InMemoryRealWorldOutcomeStore implements RealWorldOutcomeStore {
  private readonly observations: RealWorldOutcomeObservation[] = [];
  async append(observation: RealWorldOutcomeObservation): Promise<void> {
    validateIdentity(observation.runId, observation.findingId);
    this.observations.push(Object.freeze({ ...observation }));
  }
  async query(runIds?: readonly string[]): Promise<readonly RealWorldOutcomeObservation[]> {
    return Object.freeze(this.observations.filter(({ runId }) => runIds === undefined || runIds.includes(runId)).map((value) => Object.freeze({ ...value })));
  }
}

export class InMemoryIndependenceCorpusStore implements IndependenceCorpusStore {
  private readonly observations: IndependenceObservation[] = [];
  async append(observation: IndependenceObservation): Promise<void> {
    validateIdentity(observation.runId, observation.findingId);
    if (observation.auditorIds.length < 2 || observation.independentlyFoundBy.some((id) => !observation.auditorIds.includes(id))) throw new Error("INVALID_INDEPENDENCE_OBSERVATION");
    this.observations.push(Object.freeze({ ...observation, auditorIds: Object.freeze([...observation.auditorIds]), independentlyFoundBy: Object.freeze([...observation.independentlyFoundBy]) }));
  }
  async query(runIds?: readonly string[]): Promise<readonly IndependenceObservation[]> {
    return Object.freeze(this.observations.filter(({ runId }) => runIds === undefined || runIds.includes(runId)).map((value) => Object.freeze({ ...value, auditorIds: Object.freeze([...value.auditorIds]), independentlyFoundBy: Object.freeze([...value.independentlyFoundBy]) })));
  }
}

function validateIdentity(runId: string, findingId: string): void {
  if (runId.trim() === "" || findingId.trim() === "") throw new Error("INVALID_CORPUS_OBSERVATION_IDENTITY");
}
