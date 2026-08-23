export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface ExposureRange extends ByteRange {
  readonly source: "repository" | "tool" | "context" | "artifact";
  readonly sourceId: string;
  readonly path?: string;
}

export interface InspectionRead {
  readonly path: string;
  readonly lineRanges: readonly ByteRange[];
  readonly bytesReturned: number;
}

export interface InspectionSearch {
  readonly query: string;
  readonly scope: string;
  readonly resultCount: number;
}

export interface InspectionFootprint {
  readonly reads: readonly InspectionRead[];
  readonly searches: readonly InspectionSearch[];
  readonly modulesTouched: readonly string[];
  readonly riskSurfacesTouched: readonly string[];
}

export interface ExposureFootprint {
  readonly nodeId: string;
  readonly ranges: readonly ExposureRange[];
}

interface MutableNodeFootprint {
  reads: InspectionRead[];
  searches: InspectionSearch[];
  modules: Set<string>;
  risks: Set<string>;
  exposures: ExposureRange[];
}

export class FootprintRecorder {
  private readonly nodes = new Map<string, MutableNodeFootprint>();

  recordRead(nodeId: string, read: InspectionRead): void {
    this.node(nodeId).reads.push(freezeRead(read));
  }

  recordSearch(nodeId: string, search: InspectionSearch): void {
    this.node(nodeId).searches.push(Object.freeze({ ...search }));
  }

  recordModule(nodeId: string, module: string): void { this.node(nodeId).modules.add(module); }
  recordRiskSurface(nodeId: string, surface: string): void { this.node(nodeId).risks.add(surface); }

  recordExposure(nodeId: string, ranges: readonly ExposureRange[]): void {
    const target = this.node(nodeId).exposures;
    for (const range of ranges) {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start) {
        throw new Error("INVALID_EXPOSURE_RANGE");
      }
      target.push(Object.freeze({ ...range }));
    }
  }

  inspection(nodeId: string): InspectionFootprint {
    const node = this.node(nodeId);
    return Object.freeze({
      reads: Object.freeze([...node.reads]),
      searches: Object.freeze([...node.searches]),
      modulesTouched: Object.freeze([...node.modules].sort()),
      riskSurfacesTouched: Object.freeze([...node.risks].sort()),
    });
  }

  exposure(nodeId: string): ExposureFootprint {
    return Object.freeze({ nodeId, ranges: Object.freeze([...this.node(nodeId).exposures]) });
  }

  private node(nodeId: string): MutableNodeFootprint {
    let node = this.nodes.get(nodeId);
    if (node === undefined) {
      node = { reads: [], searches: [], modules: new Set(), risks: new Set(), exposures: [] };
      this.nodes.set(nodeId, node);
    }
    return node;
  }
}

function freezeRead(read: InspectionRead): InspectionRead {
  return Object.freeze({ ...read, lineRanges: Object.freeze(read.lineRanges.map((range) => Object.freeze({ ...range }))) });
}
