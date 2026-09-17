import type { HttpClient, ProviderTransport, TransportConfiguration } from "./transport-contract.js";
import { AnthropicMessagesTransport } from "./transports/anthropic-messages.js";
import { GeminiNativeTransport } from "./transports/gemini-native.js";
import { OpenAiChatTransport } from "./transports/openai-chat.js";
import { OpenAiResponsesTransport } from "./transports/openai-responses.js";

export interface ProviderEndpoint {
  /** Endpoint identity, distinct from the wire protocol shared by compatible providers. */
  readonly id: string;
  readonly providerId: string;
  readonly transport: string;
  readonly endpoint: string;
  readonly apiKeyEnvVar: string;
}

export interface TransportFactoryOptions {
  readonly client?: HttpClient;
  readonly credential?: (environmentName: string) => string | undefined;
}

export type TransportFactory = (configuration: TransportConfiguration, options: TransportFactoryOptions) => ProviderTransport;

export const BUILTIN_TRANSPORT_FACTORIES: Readonly<Record<string, TransportFactory>> = Object.freeze({
  "openai-responses": (configuration, options) => new OpenAiResponsesTransport(configuration, options.client, options.credential),
  "openai-chat": (configuration, options) => new OpenAiChatTransport(configuration, options.client, options.credential),
  "anthropic-messages": (configuration, options) => new AnthropicMessagesTransport(configuration, options.client, options.credential),
  "gemini-native": (configuration, options) => new GeminiNativeTransport(configuration, options.client, options.credential),
});

/** Endpoint-keyed transports keep compatible services' credentials and continuations apart. */
export class ProviderRegistry {
  readonly #bindings = new Map<string, Readonly<ProviderEndpoint>>();
  readonly #transports: Readonly<Record<string, ProviderTransport>>;

  constructor(endpoints: readonly ProviderEndpoint[], options: TransportFactoryOptions & {
    readonly factories?: Readonly<Record<string, TransportFactory>>;
  } = {}) {
    const factories = { ...BUILTIN_TRANSPORT_FACTORIES, ...options.factories };
    const entries: [string, ProviderTransport][] = [];
    for (const endpoint of endpoints) {
      validateEndpoint(endpoint);
      if (this.#bindings.has(endpoint.id)) throw new Error(`DUPLICATE_PROVIDER_ENDPOINT:${endpoint.id}`);
      const factory = Object.hasOwn(factories, endpoint.transport) ? factories[endpoint.transport] : undefined;
      if (factory === undefined) throw new Error(`UNKNOWN_TRANSPORT:${endpoint.transport}`);
      const transport = factory({ endpoint: endpoint.endpoint, apiKeyEnv: endpoint.apiKeyEnvVar, compatibleProviderName: endpoint.providerId }, options);
      this.#bindings.set(endpoint.id, Object.freeze({ ...endpoint }));
      entries.push([endpoint.id, transport]);
    }
    this.#transports = Object.freeze(Object.fromEntries(entries));
  }

  get transports(): Readonly<Record<string, ProviderTransport>> { return this.#transports; }

  binding(endpointId: string, expected?: { readonly providerId: string; readonly transport: string }): Readonly<ProviderEndpoint> {
    const binding = this.#bindings.get(endpointId);
    if (binding === undefined) throw new Error(`UNKNOWN_PROVIDER_ENDPOINT:${endpointId}`);
    if (expected !== undefined && (binding.providerId !== expected.providerId || binding.transport !== expected.transport)) {
      throw new Error(`MODEL_ENDPOINT_MISMATCH:${endpointId}`);
    }
    return binding;
  }
}

function validateEndpoint(value: ProviderEndpoint): void {
  for (const field of [value.id, value.providerId, value.transport]) {
    if (typeof field !== "string" || field.trim() === "") throw new Error("INVALID_PROVIDER_ENDPOINT_ID");
  }
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(value.apiKeyEnvVar)) throw new Error("INVALID_CREDENTIAL_ENVIRONMENT_REFERENCE");
  let url: URL;
  try { url = new URL(value.endpoint); } catch { throw new Error("INVALID_TRANSPORT_ENDPOINT"); }
  // Endpoint configuration is persisted. Credentials belong only in the environment.
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("INVALID_TRANSPORT_ENDPOINT");
  }
}
