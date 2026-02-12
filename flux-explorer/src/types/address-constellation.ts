export type ConstellationHop = 0 | 1 | 2;

export type ConstellationDirection = "inbound" | "outbound" | "mixed";

export interface AddressConstellationNode {
  id: string;
  label: string;
  hop: ConstellationHop;
  txCount: number;
  volume: number;
  inboundTxCount: number;
  outboundTxCount: number;
  score: number;
  balance: number | null;
}

export interface AddressConstellationEdge {
  source: string;
  target: string;
  txCount: number;
  volume: number;
  direction: ConstellationDirection;
  strength: number;
}

export interface AddressConstellationStats {
  analyzedTransactions: number;
  hopRequests: number;
  firstHopCount: number;
  secondHopCount: number;
  edgeCount: number;
}

export interface AddressConstellationData {
  center: string;
  generatedAt: string;
  nodes: AddressConstellationNode[];
  edges: AddressConstellationEdge[];
  stats: AddressConstellationStats;
  truncated: {
    firstHop: boolean;
    secondHop: boolean;
    requests: boolean;
  };
}
