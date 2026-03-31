/**
 * A2A Gateway plugin endpoints:
 * - /.well-known/agent.json  (Agent Card discovery)
 * - /a2a/jsonrpc              (JSON-RPC transport)
 * - /a2a/rest                 (REST transport)
 * - gRPC on port+1            (gRPC transport)
 */

import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
} from "@a2a-js/sdk/server/express";
import { grpcService, A2AService, UserBuilder as GrpcUserBuilder } from "@a2a-js/sdk/server/grpc";
import { Server as GrpcServer, ServerCredentials, status as GrpcStatus } from "@grpc/grpc-js";
import express from "express";
import { buildAgentCard } from "./src/agent-card.js";
import { AuditLogger } from "./src/audit.js";
import { A2AClient } from "./src/client.js";
import {
  DnsDiscoveryManager,
  mergeWithStaticPeers,
  parseDnsDiscoveryConfig,
} from "./src/dns-discovery.js";
import { MdnsResponder, buildMdnsAdvertiseConfig } from "./src/dns-responder.js";
import { OpenClawAgentExecutor } from "./src/executor.js";
import { validateUri, validateMimeType } from "./src/file-security.js";
import { PeerHealthManager } from "./src/peer-health.js";
import { PushNotificationStore } from "./src/push-notifications.js";
import { QueueingAgentExecutor } from "./src/queueing-executor.js";
import {
  RegistryManager,
  discoverOwnerAccountId,
  discoverBotId,
  discoverBotName,
  type A2AAgentCard,
  type PeerFromRegistry,
} from "./src/registry.js";
import { parseRoutingRules, matchRule } from "./src/routing-rules.js";
import { runTaskCleanup } from "./src/task-cleanup.js";
import { FileTaskStore } from "./src/task-store.js";
import { GatewayTelemetry } from "./src/telemetry.js";
import type {
  AgentCardConfig,
  GatewayConfig,
  InboundAuth,
  OpenClawPluginApi,
  PeerConfig,
} from "./src/types.js";

/** Build a JSON-RPC error response. */
function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return fallback;
}

// Module-level shared state (shared across all register() invocations)
let _sharedRegistryManager: RegistryManager | null = null;
let _sharedRegistryPeersCache: PeerConfig[] = [];
let _sharedOwnerAccountId: string | undefined;

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}

function normalizeHttpPath(value: string, fallback: string): string {
  const trimmed = value.trim() || fallback;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveConfiguredPath(
  value: unknown,
  fallback: string,
  resolvePath?: (nextPath: string) => string,
): string {
  const configured = asString(value, "").trim() || fallback;
  const resolved = resolvePath ? resolvePath(configured) : configured;
  return path.isAbsolute(resolved) ? resolved : path.resolve(resolved);
}

function parseAgentCard(raw: Record<string, unknown>): AgentCardConfig {
  const skills = Array.isArray(raw.skills) ? raw.skills : [];

  return {
    name: asString(raw.name, "OpenClaw A2A Gateway"),
    description: asString(raw.description, "A2A bridge for OpenClaw agents"),
    url: asString(raw.url, ""),
    skills: skills.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const skill = asObject(entry);
      return {
        id: asString(skill.id, ""),
        name: asString(skill.name, "unknown"),
        description: asString(skill.description, ""),
      };
    }),
  };
}

function parsePeers(raw: unknown): PeerConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const peers: PeerConfig[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const name = asString(value.name, "");
    const agentCardUrl = asString(value.agentCardUrl, "");
    if (!name || !agentCardUrl) {
      continue;
    }

    const authRaw = asObject(value.auth);
    const authTypeRaw = asString(authRaw.type, "");
    const authType = authTypeRaw === "bearer" || authTypeRaw === "apiKey" ? authTypeRaw : "";
    const token = asString(authRaw.token, "");

    peers.push({
      name,
      agentCardUrl,
      auth: authType && token ? { type: authType, token } : undefined,
    });
  }

  return peers;
}

export function parseConfig(
  raw: unknown,
  resolvePath?: (nextPath: string) => string,
): GatewayConfig {
  const config = asObject(raw);
  const server = asObject(config.server);
  const storage = asObject(config.storage);
  const security = asObject(config.security);
  const routing = asObject(config.routing);
  const limits = asObject(config.limits);
  const observability = asObject(config.observability);
  const timeouts = asObject(config.timeouts);
  const resilience = asObject(config.resilience);
  const healthCheck = asObject(resilience.healthCheck);
  const retry = asObject(resilience.retry);
  const circuitBreaker = asObject(resilience.circuitBreaker);
  const discoveryRaw = config.discovery ? asObject(config.discovery) : undefined;

  const inboundAuth = asString(security.inboundAuth, "none") as InboundAuth;

  const defaultMimeTypes = [
    "image/*",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/json",
    "audio/*",
    "video/*",
  ];
  const rawAllowedMime = Array.isArray(security.allowedMimeTypes) ? security.allowedMimeTypes : [];
  const allowedMimeTypes =
    rawAllowedMime.length > 0
      ? rawAllowedMime.filter((v: unknown) => typeof v === "string")
      : defaultMimeTypes;
  const rawUriAllowlist = Array.isArray(security.fileUriAllowlist) ? security.fileUriAllowlist : [];
  const fileUriAllowlist = rawUriAllowlist.filter((v: unknown) => typeof v === "string");

  return {
    agentCard: parseAgentCard(asObject(config.agentCard)),
    server: {
      host: asString(server.host, "0.0.0.0"),
      port: asNumber(server.port, 18800),
    },
    storage: {
      tasksDir: resolveConfiguredPath(
        storage.tasksDir,
        path.join(os.homedir(), ".openclaw", "a2a-tasks"),
        resolvePath,
      ),
      taskTtlHours: Math.max(1, asNumber(storage.taskTtlHours, 72)),
      cleanupIntervalMinutes: Math.max(1, asNumber(storage.cleanupIntervalMinutes, 60)),
    },
    peers: parsePeers(config.peers),
    security: (() => {
      const singleToken = asString(security.token, "");
      const tokenArray = Array.isArray(security.tokens)
        ? (security.tokens as unknown[]).filter(
            (t): t is string => typeof t === "string" && t.length > 0,
          )
        : [];
      const validTokens = new Set<string>([singleToken, ...tokenArray].filter((t) => t.length > 0));
      return {
        inboundAuth: inboundAuth === "bearer" ? "bearer" : ("none" as const),
        token: singleToken,
        tokens: tokenArray,
        validTokens,
        allowedMimeTypes,
        maxFileSizeBytes: asNumber(security.maxFileSizeBytes, 52_428_800),
        maxInlineFileSizeBytes: asNumber(security.maxInlineFileSizeBytes, 10_485_760),
        fileUriAllowlist,
      };
    })(),
    routing: {
      defaultAgentId: asString(routing.defaultAgentId, "default"),
      rules: parseRoutingRules(routing.rules),
    },
    limits: {
      maxConcurrentTasks: Math.max(1, Math.floor(asNumber(limits.maxConcurrentTasks, 4))),
      maxQueuedTasks: Math.max(0, Math.floor(asNumber(limits.maxQueuedTasks, 100))),
    },
    observability: {
      structuredLogs: asBoolean(observability.structuredLogs, true),
      exposeMetricsEndpoint: asBoolean(observability.exposeMetricsEndpoint, true),
      metricsPath: normalizeHttpPath(
        asString(observability.metricsPath, "/a2a/metrics"),
        "/a2a/metrics",
      ),
      metricsAuth: asString(observability.metricsAuth, "none") === "bearer" ? "bearer" : "none",
      auditLogPath: resolveConfiguredPath(
        observability.auditLogPath,
        path.join(os.homedir(), ".openclaw", "a2a-audit.jsonl"),
        resolvePath,
      ),
    },
    timeouts: {
      agentResponseTimeoutMs: asNumber(timeouts.agentResponseTimeoutMs, 300_000),
    },
    resilience: {
      healthCheck: {
        enabled: asBoolean(healthCheck.enabled, true),
        intervalMs: asNumber(healthCheck.intervalMs, 30_000),
        timeoutMs: asNumber(healthCheck.timeoutMs, 5_000),
      },
      retry: {
        maxRetries: Math.max(0, Math.floor(asNumber(retry.maxRetries, 3))),
        baseDelayMs: asNumber(retry.baseDelayMs, 1_000),
        maxDelayMs: asNumber(retry.maxDelayMs, 10_000),
      },
      circuitBreaker: {
        failureThreshold: Math.max(1, Math.floor(asNumber(circuitBreaker.failureThreshold, 5))),
        resetTimeoutMs: asNumber(circuitBreaker.resetTimeoutMs, 30_000),
      },
    },
    discovery: parseDnsDiscoveryConfig(discoveryRaw),
    advertise: buildMdnsAdvertiseConfig({
      agentCardName: asString(asObject(config.agentCard).name, "OpenClaw A2A Gateway"),
      serverHost: asString(asObject(config.server).host, "0.0.0.0"),
      serverPort: asNumber(asObject(config.server).port, 18800),
      inboundAuth: asString(asObject(config.security).inboundAuth, "none"),
      token: asString(asObject(config.security).token, "") || undefined,
      raw: config.advertise ? asObject(config.advertise) : undefined,
    }),
  };
}

function normalizeCardPath(): string {
  if (AGENT_CARD_PATH.startsWith("/")) {
    return AGENT_CARD_PATH;
  }

  return `/${AGENT_CARD_PATH}`;
}

const plugin = {
  id: "a2a-gateway",
  name: "A2A Gateway",
  description: "OpenClaw plugin that serves A2A v0.3.0 endpoints",

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig, api.resolvePath?.bind(api));
    const telemetry = new GatewayTelemetry(api.logger, {
      structuredLogs: config.observability.structuredLogs,
    });
    const auditLogger = new AuditLogger(config.observability.auditLogPath);
    const pushStore = new PushNotificationStore();
    const client = new A2AClient();
    const taskStore = new FileTaskStore(config.storage.tasksDir);
    const innerExecutor = new OpenClawAgentExecutor(api, config);
    const executor = new QueueingAgentExecutor(innerExecutor, telemetry, config.limits);
    // Auto-set agentCard.url: use LAN IP when available (cross-server), else container hostname
    if (!config.agentCard.url) {
      const lanIp = process.env.CARHER_LAN_IP;
      const a2aPort = process.env.CARHER_A2A_PORT || String(config.server.port);
      const host = lanIp ? `${lanIp}:${a2aPort}` : `${discoverBotId() || os.hostname()}:${config.server.port}`;
      config.agentCard.url = `http://${host}/a2a/jsonrpc`;
      api.logger.info(`a2a-gateway: auto-set agentCard.url to ${config.agentCard.url}`);
    }
    const agentCard = buildAgentCard(config);

    // ------------------------------------------------------------------
    // Redis Registry: self-registration + peer discovery
    // ------------------------------------------------------------------
    // _sharedRegistryManager is module-level (_sharedRegistryManager) to survive multiple register() calls
    // Owner account is module-level so it survives multiple register() calls
    if (!_sharedOwnerAccountId) {
      _sharedOwnerAccountId = discoverOwnerAccountId();
    }
    // Pass owner account to executor so A2A sessions use owner's OAuth token
    innerExecutor.ownerAccountId = _sharedOwnerAccountId;
    if (_sharedOwnerAccountId) {
      api.logger.info(`a2a-gateway: discovered owner account: ${_sharedOwnerAccountId}`);
    }

    // Redis registry is initialized lazily in service start (async context)
    const redisUrl = process.env.REDIS_URL;
    // Resolve bot name: feishu channel name (from config) > IDENTITY.md > container hostname
    const feishuChannelName = asString(
      (asObject((asObject(api.config) as any)?.channels)?.feishu as any)?.name,
    );
    const resolvedBotName = feishuChannelName || discoverBotName();

    const registryInitConfig = redisUrl
      ? {
          redisUrl,
          botId: discoverBotId(),
          botName: resolvedBotName,
          port: config.server.port,
          ownerAccountId,
          skills: Array.isArray(config.agentCard.skills)
            ? config.agentCard.skills
            : [{ id: "chat", name: "chat" }],
        }
      : null;

    if (!redisUrl) {
      api.logger.info("a2a-gateway: no REDIS_URL, registry disabled (static peers only)");
    }

    // Peer resilience: health check + circuit breaker
    const healthManager =
      config.peers.length > 0
        ? new PeerHealthManager(
            config.peers,
            config.resilience.healthCheck,
            config.resilience.circuitBreaker,
            async (peer) => {
              try {
                const card = await client.discoverAgentCard(
                  peer,
                  config.resilience.healthCheck.timeoutMs,
                );
                // Cache skills from Agent Card for routing rule matching
                const skills = Array.isArray(card?.skills)
                  ? (card.skills as Array<Record<string, unknown>>)
                      .map((s) =>
                        typeof s === "string" ? s : typeof s?.id === "string" ? s.id : "",
                      )
                      .filter((id) => id.length > 0)
                  : [];
                healthManager!.updateSkills(peer.name, skills);
                return true;
              } catch {
                return false;
              }
            },
            (level, msg, details) => {
              if (level === "error") {
                api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
              } else if (level === "warn") {
                api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
              } else {
                api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
              }
            },
          )
        : null;

    // DNS-SD discovery manager (disabled by default)
    const discoveryManager = config.discovery.enabled
      ? new DnsDiscoveryManager(config.discovery, (level, msg, details) => {
          if (level === "error") {
            api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else if (level === "warn") {
            api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else {
            api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          }
        })
      : null;

    // mDNS responder for self-advertisement (disabled by default)
    const mdnsResponder = config.advertise.enabled
      ? new MdnsResponder(config.advertise, (level, msg, details) => {
          if (level === "error") {
            api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else if (level === "warn") {
            api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else {
            api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          }
        })
      : null;

    /**
     * Get the effective peer list: static peers + DNS discovered + Redis registry.
     * Static peers always take precedence on name collision.
     */
    // _sharedRegistryPeersCache is module-level (_sharedRegistryPeersCache)
    

    const getEffectivePeers = (): PeerConfig[] => {
      let basePeers: PeerConfig[];
      if (!discoveryManager) {
        basePeers = config.peers;
      } else if (!config.discovery.mergeWithStatic) {
        basePeers = discoveryManager.toPeerConfigs();
      } else {
        basePeers = mergeWithStaticPeers(config.peers, discoveryManager.getDiscoveredPeers());
      }

      // Merge with Redis registry peers (cached, refreshed async)
      if (_sharedRegistryPeersCache.length > 0) {
        const staticNames = new Set(basePeers.map((p) => p.name));
        const registryOnly = _sharedRegistryPeersCache.filter((p) => !staticNames.has(p.name));
        return [...basePeers, ...registryOnly];
      }
      return basePeers;
    };

    // Async registry peer refresh (non-blocking)
    const refreshRegistryPeers = async (): Promise<void> => {
      if (!_sharedRegistryManager) {
        api.logger.warn?.("a2a-gateway: refreshRegistryPeers skipped (_sharedRegistryManager is null)");
        return;
      }
      try {
        const peers = await _sharedRegistryManager.getPeers();
        api.logger.info?.(`a2a-gateway: refreshRegistryPeers found ${peers.length} peers`);
        _sharedRegistryPeersCache = peers.map((p) => ({
          name: p.name,
          agentCardUrl: p.agentCardUrl,
          auth: undefined as any,
        }));
      } catch {
        // Keep stale cache
      }
    };

    /**
     * Look up a peer by name from the effective peer list.
     */
    const findPeer = (name: string): PeerConfig | undefined => {
      return getEffectivePeers().find((p) => p.name.toLowerCase() === name.toLowerCase());
    };

    // Wire peer state into telemetry snapshot
    if (healthManager) {
      telemetry.setPeerStateProvider(() => healthManager.getAllStates());
    }

    // Wire audit logger + push notifications for inbound task completion
    telemetry.setTaskAuditCallback((taskId, contextId, state, durationMs) => {
      auditLogger.recordInbound(taskId, contextId, state, durationMs);

      // Fire-and-forget push notification for terminal states
      if (
        pushStore.has(taskId) &&
        (state === "completed" || state === "failed" || state === "canceled")
      ) {
        taskStore
          .load(taskId)
          .then((task) => {
            if (!task) {
              return;
            }
            return pushStore.send(taskId, state, task);
          })
          .then((result) => {
            if (result && result.ok) {
              api.logger.info(`a2a-gateway: push notification sent for task ${taskId} (${state})`);
            } else if (result) {
              api.logger.warn(
                `a2a-gateway: push notification failed for task ${taskId}: ${result.error}`,
              );
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            api.logger.warn(`a2a-gateway: push notification error for task ${taskId}: ${msg}`);
          });
      }
    });

    // SDK expects userBuilder(req) -> Promise<User>
    // When bearer auth is configured, validate the Authorization header.
    const userBuilder = async (req: {
      headers?: Record<string, string | string[] | undefined>;
    }) => {
      if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
        const authHeader = req.headers?.authorization;
        const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const providedToken =
          typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!providedToken || !config.security.validTokens.has(providedToken)) {
          telemetry.recordSecurityRejection("http", "invalid or missing bearer token");
          auditLogger.recordSecurityEvent("http", "invalid or missing bearer token");
          throw jsonRpcError(null, -32000, "Unauthorized: invalid or missing bearer token");
        }
      }
      return UserBuilder.noAuthentication();
    };

    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

    const app = express();
    const createHttpMetricsMiddleware =
      (route: "jsonrpc" | "rest" | "metrics") =>
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        const startedAt = Date.now();
        res.on("finish", () => {
          telemetry.recordInboundHttp(route, res.statusCode, Date.now() - startedAt);
        });
        next();
      };

    const cardPath = normalizeCardPath();
    const cardEndpointHandler = agentCardHandler({ agentCardProvider: requestHandler });

    app.use(cardPath, cardEndpointHandler);
    if (cardPath != "/.well-known/agent.json") {
      app.use("/.well-known/agent.json", cardEndpointHandler);
    }

    app.use(
      "/a2a/jsonrpc",
      createHttpMetricsMiddleware("jsonrpc"),
      jsonRpcHandler({
        requestHandler,
        userBuilder,
      }),
    );

    // Ensure errors return JSON-RPC style responses (avoid Express HTML error pages)
    app.use(
      "/a2a/jsonrpc",
      (err: unknown, _req: unknown, res: any, next: (e?: unknown) => void) => {
        if (err instanceof SyntaxError) {
          res.status(400).json(jsonRpcError(null, -32700, "Parse error"));
          return;
        }

        // Surface A2A-specific errors with proper codes
        const a2aErr = err as { code?: number; message?: string; taskId?: string } | undefined;
        if (a2aErr && typeof a2aErr.code === "number") {
          const status = a2aErr.code === -32601 ? 404 : 400;
          res
            .status(status)
            .json(jsonRpcError(null, a2aErr.code, a2aErr.message || "Unknown error"));
          return;
        }

        // Generic internal error
        res.status(500).json(jsonRpcError(null, -32603, "Internal error"));
      },
    );

    app.use(
      "/a2a/rest",
      createHttpMetricsMiddleware("rest"),
      restHandler({
        requestHandler,
        userBuilder,
      }),
    );

    if (config.observability.exposeMetricsEndpoint) {
      app.get(
        config.observability.metricsPath,
        createHttpMetricsMiddleware("metrics"),
        (req, res, next) => {
          if (
            config.observability.metricsAuth === "bearer" &&
            config.security.validTokens.size > 0
          ) {
            const authHeader = req.headers.authorization;
            const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
            const token =
              typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
            if (!token || !config.security.validTokens.has(token)) {
              res.status(401).json({ error: "Unauthorized: invalid or missing bearer token" });
              return;
            }
          }
          next();
        },
        (_req, res) => {
          res.json(telemetry.snapshot());
        },
      );
    }

    // Bearer auth middleware for push notification endpoints
    const pushAuthMiddleware = (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
        const authHeader = req.headers.authorization;
        const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const token =
          typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token || !config.security.validTokens.has(token)) {
          res.status(401).json({ error: "Unauthorized: invalid or missing bearer token" });
          return;
        }
      }
      next();
    };

    // REST endpoints for push notification registration
    app.post("/a2a/push/register", pushAuthMiddleware, express.json(), async (req, res) => {
      const body = asObject(req.body);
      const taskId = asString(body.taskId, "");
      const url = asString(body.url, "");
      if (!taskId || !url) {
        res.status(400).json({ error: "taskId and url are required" });
        return;
      }

      // SSRF validation: reuse file-security's URI validation
      const uriCheck = await validateUri(url, config.security);
      if (!uriCheck.ok) {
        res.status(400).json({ error: `Webhook URL rejected: ${uriCheck.reason}` });
        return;
      }

      const token = asString(body.token, "") || undefined;
      const events = Array.isArray(body.events)
        ? (body.events as unknown[]).filter((e): e is string => typeof e === "string")
        : undefined;
      pushStore.register(taskId, { url, token, events });
      res.json({ taskId, registered: true });
    });

    app.delete("/a2a/push/:taskId", pushAuthMiddleware, (req, res) => {
      const rawTaskId = req.params.taskId;
      const taskId = typeof rawTaskId === "string" ? rawTaskId : "";
      if (!taskId) {
        res.status(400).json({ error: "taskId is required" });
        return;
      }
      const existed = pushStore.has(taskId);
      pushStore.unregister(taskId);
      res.json({ taskId, removed: existed });
    });

    let server: Server | null = null;
    let grpcServer: GrpcServer | null = null;
    let cleanupTimer: ReturnType<typeof setInterval> | null = null;
    const grpcPort = config.server.port + 1;

    api.registerGatewayMethod("a2a.metrics", ({ respond }) => {
      respond(true, {
        metrics: telemetry.snapshot(),
      });
    });

    api.registerGatewayMethod("a2a.audit", ({ params, respond }) => {
      const payload = asObject(params);
      const count = Math.min(Math.max(1, asNumber(payload.count, 50)), 500);
      auditLogger
        .tail(count)
        .then((entries) => respond(true, { entries, count: entries.length }))
        .catch((error) => respond(false, { error: String(error?.message || error) }));
    });

    api.registerGatewayMethod("a2a.pushNotification.register", ({ params, respond }) => {
      const payload = asObject(params);
      const taskId = asString(payload.taskId, "");
      const url = asString(payload.url, "");
      if (!taskId || !url) {
        respond(false, { error: "taskId and url are required" });
        return;
      }

      // SSRF validation on webhook URL
      validateUri(url, config.security)
        .then((uriCheck) => {
          if (!uriCheck.ok) {
            respond(false, { error: `Webhook URL rejected: ${uriCheck.reason}` });
            return;
          }
          const token = asString(payload.token, "") || undefined;
          const events = Array.isArray(payload.events)
            ? (payload.events as unknown[]).filter((e): e is string => typeof e === "string")
            : undefined;
          pushStore.register(taskId, { url, token, events });
          respond(true, { taskId, registered: true });
        })
        .catch((err) => {
          respond(false, {
            error: `URI validation failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    });

    api.registerGatewayMethod("a2a.pushNotification.unregister", ({ params, respond }) => {
      const payload = asObject(params);
      const taskId = asString(payload.taskId, "");
      if (!taskId) {
        respond(false, { error: "taskId is required" });
        return;
      }
      const existed = pushStore.has(taskId);
      pushStore.unregister(taskId);
      respond(true, { taskId, removed: existed });
    });

    api.registerGatewayMethod("a2a.send", ({ params, respond }) => {
      const payload = asObject(params);
      let peerName = asString(payload.peer || payload.name, "");
      const message = asObject(payload.message || payload.payload);

      // Rule-based routing: auto-select peer when not explicitly provided
      if (!peerName && config.routing.rules.length > 0) {
        const msgText =
          typeof message.text === "string"
            ? message.text
            : typeof message.message === "string"
              ? message.message
              : "";
        const msgTags = Array.isArray(message.tags)
          ? (message.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
        const peerSkills = healthManager?.getPeerSkills();
        const routeMatch = matchRule(
          config.routing.rules,
          { text: msgText, tags: msgTags },
          peerSkills,
        );
        if (routeMatch) {
          peerName = routeMatch.peer;
          if (routeMatch.agentId && !message.agentId) {
            message.agentId = routeMatch.agentId;
          }
          api.logger.info(
            `a2a-gateway: rule-based routing matched → peer="${peerName}"${routeMatch.agentId ? ` agentId="${routeMatch.agentId}"` : ""}`,
          );
        }
      }

      const peer = findPeer(peerName);
      if (!peer) {
        const hint = peerName
          ? `Peer not found: ${peerName}`
          : "No peer specified and no routing rule matched";
        respond(false, { error: hint });
        return;
      }

      const startedAt = Date.now();
      const sendOptions = {
        healthManager: healthManager ?? undefined,
        retryConfig: config.resilience.retry,
        log: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => {
          if (details?.attempt) {
            telemetry.recordPeerRetry(peer.name, details.attempt as number);
          }
          api.logger[level](details ? `${msg}: ${JSON.stringify(details)}` : msg);
        },
      };
      client
        .sendMessage(peer, message, sendOptions)
        .then((result) => {
          const outDuration = Date.now() - startedAt;
          telemetry.recordOutboundRequest(peer.name, result.ok, result.statusCode, outDuration);
          auditLogger.recordOutbound(peer.name, result.ok, result.statusCode, outDuration);
          if (result.ok) {
            respond(true, {
              statusCode: result.statusCode,
              response: result.response,
            });
            return;
          }

          respond(false, {
            statusCode: result.statusCode,
            response: result.response,
          });
        })
        .catch((error) => {
          const errDuration = Date.now() - startedAt;
          telemetry.recordOutboundRequest(peer.name, false, 500, errDuration);
          auditLogger.recordOutbound(peer.name, false, 500, errDuration);
          respond(false, { error: String(error?.message || error) });
        });
    });

    // ------------------------------------------------------------------
    // Agent tool: a2a_send_file
    // Lets the agent send a file (by URI) to a peer via A2A FilePart.
    // ------------------------------------------------------------------
    if (api.registerTool) {
      const sendFileParams = {
        type: "object" as const,
        required: ["peer", "uri"],
        properties: {
          peer: {
            type: "string" as const,
            description: "Name of the target peer (must match a configured peer name)",
          },
          uri: { type: "string" as const, description: "Public URL of the file to send" },
          name: { type: "string" as const, description: "Filename (e.g. report.pdf)" },
          mimeType: {
            type: "string" as const,
            description:
              "MIME type (e.g. application/pdf). Auto-detected from extension if omitted.",
          },
          text: {
            type: "string" as const,
            description: "Optional text message to include alongside the file",
          },
          agentId: {
            type: "string" as const,
            description:
              "Route to a specific agentId on the peer (OpenClaw extension). Omit to use the peer's default agent.",
          },
        },
      };

      api.registerTool({
        name: "a2a_send_file",
        description:
          "Send a file to a peer agent via A2A. The file is referenced by its public URL (URI). " +
          "Use this when you need to transfer a document, image, or any file to another agent.",
        label: "A2A Send File",
        parameters: sendFileParams,
        async execute(toolCallId, params) {
          const peer = findPeer(params.peer);
          if (!peer) {
            const available =
              getEffectivePeers()
                .map((p) => p.name)
                .join(", ") || "(none)";
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Peer not found: "${params.peer}". Available peers: ${available}`,
                },
              ],
              details: { ok: false },
            };
          }

          // Security checks: SSRF, MIME, file size
          const uriCheck = await validateUri(params.uri, config.security);
          if (!uriCheck.ok) {
            return {
              content: [{ type: "text" as const, text: `URI rejected: ${uriCheck.reason}` }],
              details: { ok: false, reason: uriCheck.reason },
            };
          }

          if (
            params.mimeType &&
            !validateMimeType(params.mimeType, config.security.allowedMimeTypes)
          ) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `MIME type rejected: "${params.mimeType}" is not in the allowed list`,
                },
              ],
              details: { ok: false },
            };
          }

          const parts: Array<Record<string, unknown>> = [];
          if (params.text) {
            parts.push({ kind: "text", text: params.text });
          }
          parts.push({
            kind: "file",
            file: {
              uri: params.uri,
              ...(params.name ? { name: params.name } : {}),
              ...(params.mimeType ? { mimeType: params.mimeType } : {}),
            },
          });

          try {
            const message: Record<string, unknown> = { parts };
            if (params.agentId) {
              message.agentId = params.agentId;
            }
            const result = await client.sendMessage(peer, message, {
              healthManager: healthManager ?? undefined,
              retryConfig: config.resilience.retry,
            });
            if (result.ok) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `File sent to ${params.peer} via A2A.\nURI: ${params.uri}\nResponse: ${JSON.stringify(result.response)}`,
                  },
                ],
                details: { ok: true, response: result.response },
              };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to send file to ${params.peer}: ${JSON.stringify(result.response)}`,
                },
              ],
              details: { ok: false, response: result.response },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [
                { type: "text" as const, text: `Error sending file to ${params.peer}: ${msg}` },
              ],
              details: { ok: false, error: msg },
            };
          }
        },
      });
    }

    // ------------------------------------------------------------------
    // Agent tool: a2a_send
    // Lets the agent send a text message to a peer and get its response.
    // ------------------------------------------------------------------

    // Extract text from an A2A response (Task or Message with text parts)
    const extractResponseText = (response: unknown): string | undefined => {
      if (!response || typeof response !== "object") {
        return undefined;
      }
      const r = response as Record<string, unknown>;
      // Task response: status.message.parts[].text or artifacts[].parts[].text
      const statusMsg = (r.status as any)?.message;
      const artifacts = r.artifacts;
      const parts =
        statusMsg?.parts ??
        (Array.isArray(artifacts) ? artifacts.flatMap((a: any) => a?.parts ?? []) : r.parts);
      if (!Array.isArray(parts)) {
        return undefined;
      }
      return (
        parts
          .filter((p: any) => p?.kind === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n") || undefined
      );
    };
    if (api.registerTool) {
      const sendParams = {
        type: "object" as const,
        required: ["peer", "message"],
        properties: {
          peer: {
            type: "string" as const,
            description:
              "Name of the target peer (must match a configured peer name). Call with peer='?' to list available peers.",
          },
          message: {
            type: "string" as const,
            description: "The text message to send to the peer agent",
          },
          agentId: {
            type: "string" as const,
            description: "Route to a specific agentId on the peer (optional, omit to use default)",
          },
        },
      };

      api.registerTool({
        name: "a2a_send",
        description:
          "Send a text message to a peer agent via A2A (Agent-to-Agent protocol) and receive their response. " +
          "Use this when you need to ask another bot for information, delegate a task, or collaborate across agents. " +
          "Call with peer='?' to list all available peers.",
        label: "A2A Send Message",
        parameters: sendParams,
        async execute(_toolCallId, params) {
          // Ensure registry cache is fresh before any peer lookup
          await refreshRegistryPeers();

          // List peers on demand
          if (params.peer === "?") {
            const peers = getEffectivePeers();
            if (peers.length === 0) {
              return { content: [{ type: "text" as const, text: "No A2A peers configured." }] };
            }
            const list = peers.map((p) => `- ${p.name} (${p.agentCardUrl})`).join("\n");
            return { content: [{ type: "text" as const, text: `Available A2A peers:\n${list}` }] };
          }

          const peer = findPeer(params.peer);
          if (!peer) {
            const available =
              getEffectivePeers()
                .map((p) => p.name)
                .join(", ") || "(none)";
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Peer not found: "${params.peer}". Available peers: ${available}`,
                },
              ],
            };
          }

          const parts: Array<Record<string, unknown>> = [{ kind: "text", text: params.message }];
          const message: Record<string, unknown> = { parts };
          if (params.agentId) {
            message.agentId = params.agentId;
          }

          try {
            const result = await client.sendMessage(peer, message, {
              healthManager: healthManager ?? undefined,
              retryConfig: config.resilience.retry,
            });
            if (result.ok) {
              // Extract text from the response
              const respText =
                extractResponseText(result.response) || JSON.stringify(result.response);
              return {
                content: [{ type: "text" as const, text: respText }],
                details: { ok: true, peer: params.peer },
              };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: `A2A call to "${params.peer}" failed: ${JSON.stringify(result.response)}`,
                },
              ],
              details: { ok: false, peer: params.peer },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [
                { type: "text" as const, text: `A2A error calling "${params.peer}": ${msg}` },
              ],
              details: { ok: false, error: msg },
            };
          }
        },
      });
    }

    if (!api.registerService) {
      api.logger.warn(
        "a2a-gateway: registerService is unavailable; HTTP endpoints are not started",
      );
      return;
    }

    api.registerService({
      id: "a2a-gateway",
      async start(_ctx) {
        if (server) {
          return;
        }

        // Start Redis registry (self-register + discover peers)
        if (registryInitConfig) {
          try {
            // ioredis lives in the main app's node_modules (flat or pnpm hoisted)
            const IoRedis = (() => {
              for (const p of ["ioredis", "/app/node_modules/ioredis"]) {
                try { const m = require(p); return m.default || m; } catch {}
              }
              // pnpm hoisted path
              const fs = require("fs");
              const dir = "/app/node_modules/.pnpm";
              if (fs.existsSync(dir)) {
                for (const d of fs.readdirSync(dir)) {
                  if (d.startsWith("ioredis@")) {
                    const m = require(`${dir}/${d}/node_modules/ioredis`);
                    return m.default || m;
                  }
                }
              }
              throw new Error("ioredis not found");
            })();
            const redis = new IoRedis(registryInitConfig.redisUrl, {
              lazyConnect: true,
              maxRetriesPerRequest: 2,
            });
            await redis.connect();

            const lanIp = process.env.CARHER_LAN_IP || "";
            const a2aPort = process.env.CARHER_A2A_PORT || String(registryInitConfig.port);
            const lanEndpoint = lanIp ? `http://${lanIp}:${a2aPort}/a2a/jsonrpc` : undefined;

            const registryCard: A2AAgentCard = {
              id: registryInitConfig.botId,
              name: registryInitConfig.botName,
              server: process.env.CARHER_SERVER || "local",
              endpoints: {
                docker: `http://${registryInitConfig.botId}:${registryInitConfig.port}/a2a/jsonrpc`,
                ...(lanEndpoint ? { lan: lanEndpoint } : {}),
              },
              ownerAccountId: registryInitConfig.ownerAccountId,
              skills: registryInitConfig.skills,
              registeredAt: new Date().toISOString(),
            };

            _sharedRegistryManager = new RegistryManager(redis, registryCard, (msg) =>
              api.logger.info(msg),
            );
            await _sharedRegistryManager.start();
            await refreshRegistryPeers();
            setInterval(() => refreshRegistryPeers().catch(() => {}), 30_000);
          } catch (err) {
            api.logger.warn(`a2a-gateway: Redis registry failed: ${err}`);
          }
        }

        // Start DNS-SD discovery (if enabled)
        discoveryManager?.start();

        // Start peer health checks
        healthManager?.start();

        // Start HTTP server (JSON-RPC + REST)
        await new Promise<void>((resolve, reject) => {
          server = app.listen(config.server.port, config.server.host, () => {
            api.logger.info(
              `a2a-gateway: HTTP listening on ${config.server.host}:${config.server.port}`,
            );
            api.logger.info(
              `a2a-gateway: durable task store at ${config.storage.tasksDir}; concurrency=${config.limits.maxConcurrentTasks}; queue=${config.limits.maxQueuedTasks}`,
            );
            resolve();
          });

          server.once("error", reject);
        });

        // Start gRPC server
        try {
          grpcServer = new GrpcServer();
          const grpcUserBuilder = async (
            call: { metadata?: { get: (key: string) => unknown[] } } | unknown,
          ) => {
            if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
              const meta = (call as any)?.metadata;
              const values = meta?.get?.("authorization") || meta?.get?.("Authorization") || [];
              const header = Array.isArray(values) && values.length > 0 ? String(values[0]) : "";
              const providedToken = header.startsWith("Bearer ") ? header.slice(7) : "";
              if (!providedToken || !config.security.validTokens.has(providedToken)) {
                telemetry.recordSecurityRejection("grpc", "invalid or missing bearer token");
                auditLogger.recordSecurityEvent("grpc", "invalid or missing bearer token");
                const err: any = new Error("Unauthorized: invalid or missing bearer token");
                err.code = GrpcStatus.UNAUTHENTICATED;
                throw err;
              }
            }
            return GrpcUserBuilder.noAuthentication();
          };

          grpcServer.addService(
            A2AService,
            grpcService({ requestHandler, userBuilder: grpcUserBuilder as any }),
          );

          await new Promise<void>((resolve, reject) => {
            grpcServer!.bindAsync(
              `${config.server.host}:${grpcPort}`,
              ServerCredentials.createInsecure(),
              (error) => {
                if (error) {
                  api.logger.warn(`a2a-gateway: gRPC failed to start: ${error.message}`);
                  grpcServer = null;
                  resolve(); // Non-fatal: HTTP still works
                  return;
                }
                try {
                  grpcServer!.start();
                } catch {
                  // ignore: some grpc-js versions auto-start
                }
                api.logger.info(`a2a-gateway: gRPC listening on ${config.server.host}:${grpcPort}`);
                resolve();
              },
            );
          });
        } catch (grpcError: unknown) {
          const msg = grpcError instanceof Error ? grpcError.message : String(grpcError);
          api.logger.warn(`a2a-gateway: gRPC init failed: ${msg}`);
          grpcServer = null;
        }

        // Start task TTL cleanup
        const ttlMs = config.storage.taskTtlHours * 3_600_000;
        const intervalMs = config.storage.cleanupIntervalMinutes * 60_000;

        const doCleanup = () => {
          void runTaskCleanup(taskStore, ttlMs, telemetry, api.logger);
        };

        // Run once at startup to clear any backlog
        doCleanup();
        cleanupTimer = setInterval(doCleanup, intervalMs);

        api.logger.info(
          `a2a-gateway: task cleanup enabled — ttl=${config.storage.taskTtlHours}h interval=${config.storage.cleanupIntervalMinutes}min`,
        );

        // Start mDNS self-advertisement (after HTTP is listening)
        mdnsResponder?.start();
      },
      async stop(_ctx) {
        // Stop Redis registry (unregister)
        if (_sharedRegistryManager) {
          await _sharedRegistryManager.stop();
        }

        // Stop mDNS self-advertisement (sends goodbye packet)
        mdnsResponder?.stop();

        // Stop DNS-SD discovery
        discoveryManager?.stop();

        // Stop peer health checks
        healthManager?.stop();
        auditLogger.close();

        // Stop task cleanup timer
        if (cleanupTimer) {
          clearInterval(cleanupTimer);
          cleanupTimer = null;
        }

        // Stop gRPC server
        if (grpcServer) {
          grpcServer.forceShutdown();
          grpcServer = null;
        }

        // Stop HTTP server
        if (!server) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const activeServer = server!;
          server = null;
          activeServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      },
    });
  },
};

export default plugin;
