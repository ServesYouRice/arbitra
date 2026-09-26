import { BUILTIN_BATCH_DRIVER_FACTORIES, unsupportedBatchEndpointMessage, type BatchDriverFactory } from "./batch/drivers.js";
import type { BatchDriver } from "./batch/contract.js";
import type { HttpClient, ProviderTransport, TransportConfiguration } from "./transport-contract.js";
import { AnthropicMessagesTransport } from "./transports/anthropic-messages.js";
import { GeminiNativeTransport } from "./transports/gemini-native.js";
import { OpenAiChatTransport } from "./transports/openai-chat.js";
import { OpenAiResponsesTransport } from "./transports/openai-responses.js";
import { cliTransportSupport, isCliEndpoint, type CliAuthMode } from "./transports/cli/support.js";
import { cliTransportFactory, type CliTransportOptions } from "./transports/cli/transport.js";

export interface ProviderEndpoint {
  /** Endpoint identity, distinct from the wire protocol shared by compatible providers. */
  readonly id: string;
  readonly providerId: string;
  readonly transport: string;
  /** An HTTP(S) base URL, or `cli://<vendor>` for a subscription CLI transport. */
  readonly endpoint: string;
  /** HTTP endpoints only: the environment variable holding the API key. */
  readonly apiKeyEnvVar?: string | undefined;
  /** CLI endpoints only: the CLI's own subscription login, or a token from `oauthTokenEnvVar`. */
  readonly auth?: CliAuthMode | undefined;
  readonly oauthTokenEnvVar?: string | undefined;
}

export interface TransportFactoryOptions {
  readonly client?: HttpClient;
  readonly credential?: (environmentName: string) => string | undefined;
  /** Subscription CLI transports: host environment, process runner and limits record. */
  readonly cli?: CliTransportOptions;
}

export type TransportFactory = (configuration: TransportConfiguration, options: TransportFactoryOptions) => ProviderTransport;

export const BUILTIN_TRANSPORT_FACTORIES: Readonly<Record<string, TransportFactory>> = Object.freeze({
  "openai-responses": (configuration, options) => new OpenAiResponsesTransport(configuration, options.client, options.credential),
  "openai-chat": (configuration, options) => new OpenAiChatTransport(configuration, options.client, options.credential),
  "anthropic-messages": (configuration, options) => new AnthropicMessagesTransport(configuration, options.client, options.credential),
  "gemini-native": (configuration, options) => new GeminiNativeTransport(configuration, options.client, options.credential),
  "claude-code-cli": cliTransportFactory("claude-code-cli"),
  "codex-cli": cliTransportFactory("codex-cli"),
  "gemini-cli": cliTransportFactory("gemini-cli"),
});

/** Endpoint-keyed transports keep compatible services' credentials and continuations apart. */
export class ProviderRegistry {
  readonly #bindings = new Map<string, Readonly<ProviderEndpoint>>();
  readonly #transports: Readonly<Record<string, ProviderTransport>>;
  readonly #batchFactories: Readonly<Record<string, BatchDriverFactory>>;
  readonly #batchDrivers = new Map<string, BatchDriver>();
  readonly #options: TransportFactoryOptions;

  constructor(endpoints: readonly ProviderEndpoint[], options: TransportFactoryOptions & {
    readonly factories?: Readonly<Record<string, TransportFactory>>;
    /** Batch drivers are keyed by transport; custom protocols may add their own. */
    readonly batchFactories?: Readonly<Record<string, BatchDriverFactory>>;
  } = {}) {
    this.#batchFactories = { ...BUILTIN_BATCH_DRIVER_FACTORIES, ...options.batchFactories };
    this.#options = { ...(options.client === undefined ? {} : { client: options.client }), ...(options.credential === undefined ? {} : { credential: options.credential }), ...(options.cli === undefined ? {} : { cli: options.cli }) };
    const factories = { ...BUILTIN_TRANSPORT_FACTORIES, ...options.factories };
    const entries: [string, ProviderTransport][] = [];
    for (const endpoint of endpoints) {
      validateEndpoint(endpoint);
      if (this.#bindings.has(endpoint.id)) throw new Error(`DUPLICATE_PROVIDER_ENDPOINT:${endpoint.id}`);
      const factory = Object.hasOwn(factories, endpoint.transport) ? factories[endpoint.transport] : undefined;
      if (factory === undefined) throw new Error(`UNKNOWN_TRANSPORT:${endpoint.transport}`);
      const transport = factory(transportConfiguration(endpoint), options);
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

  /** Whether a batch driver exists for this endpoint's transport. Does not claim live verification. */
  supportsBatch(endpointId: string): boolean {
    return Object.hasOwn(this.#batchFactories, this.binding(endpointId).transport);
  }

  /** The endpoint's batch driver, or an actionable preflight error for unsupported endpoints. */
  batchDriver(endpointId: string): BatchDriver {
    const existing = this.#batchDrivers.get(endpointId);
    if (existing !== undefined) return existing;
    const binding = this.binding(endpointId);
    const factory = Object.hasOwn(this.#batchFactories, binding.transport) ? this.#batchFactories[binding.transport] : undefined;
    if (factory === undefined) throw new Error(unsupportedBatchEndpointMessage(endpointId, binding.transport, Object.keys(this.#batchFactories)));
    const driver = factory(transportConfiguration(binding), this.#options);
    this.#batchDrivers.set(endpointId, driver);
    return driver;
  }
}

function transportConfiguration(endpoint: ProviderEndpoint): TransportConfiguration {
  return { endpoint: endpoint.endpoint, apiKeyEnv: endpoint.apiKeyEnvVar ?? "", compatibleProviderName: endpoint.providerId,
    ...(isCliEndpoint(endpoint.endpoint) ? { cli: { auth: endpoint.auth ?? "subscription_login", oauthTokenEnv: endpoint.oauthTokenEnvVar ?? null } } : {}) };
}

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;

function validateEndpoint(value: ProviderEndpoint): void {
  for (const field of [value.id, value.providerId, value.transport]) {
    if (typeof field !== "string" || field.trim() === "") throw new Error("INVALID_PROVIDER_ENDPOINT_ID");
  }
  if (typeof value.endpoint === "string" && isCliEndpoint(value.endpoint)) {
    // A subscription CLI signs in with its own login: no API key, URL or credential value belongs here.
    const support = cliTransportSupport(value.transport);
    if (support !== undefined && value.endpoint !== support.endpoint || !/^cli:\/\/[a-z][a-z0-9-]{0,40}$/u.test(value.endpoint)) throw new Error("INVALID_TRANSPORT_ENDPOINT");
    if (value.apiKeyEnvVar !== undefined) throw new Error("CLI_ENDPOINT_API_KEY_FORBIDDEN");
    const auth = value.auth ?? "subscription_login";
    if (auth !== "subscription_login" && auth !== "oauth_token" || support !== undefined && !support.authModes.includes(auth)) throw new Error("CLI_AUTH_MODE_UNSUPPORTED");
    if (auth === "oauth_token" ? value.oauthTokenEnvVar === undefined || !ENVIRONMENT_NAME.test(value.oauthTokenEnvVar) : value.oauthTokenEnvVar !== undefined) throw new Error("INVALID_CREDENTIAL_ENVIRONMENT_REFERENCE");
    return;
  }
  if (cliTransportSupport(value.transport) !== undefined) throw new Error("INVALID_TRANSPORT_ENDPOINT");
  if (value.auth !== undefined || value.oauthTokenEnvVar !== undefined) throw new Error("INVALID_PROVIDER_ENDPOINT_AUTH");
  if (value.apiKeyEnvVar === undefined || !ENVIRONMENT_NAME.test(value.apiKeyEnvVar)) throw new Error("INVALID_CREDENTIAL_ENVIRONMENT_REFERENCE");
  let url: URL;
  try { url = new URL(value.endpoint); } catch { throw new Error("INVALID_TRANSPORT_ENDPOINT"); }
  // Endpoint configuration is persisted. Credentials belong only in the environment.
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("INVALID_TRANSPORT_ENDPOINT");
  }
}
