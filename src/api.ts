import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import {
  verifyPermission,
  executeAuthorizedTransformation,
} from "./index";

import {
  registerMedia,
  type RegisteredMediaAsset,
  type RightsAction,
  type RightsPolicy,
} from "./register-media";

import type {
  ProvenanceAction,
} from "./provenance";

import {
  anchorProvenanceProof,
} from "./anchor-provenance";

import {
  createRoyaltyEvent,
  hashRoyaltyEvent,
  type RoyaltyRule,
} from "./royalties";

const PORT = 3000;

const assets = new Map<
  string,
  RegisteredMediaAsset
>();

interface RegisterRequest {
  assetId: string;
  title: string;
  owner: string;
  sourceUri: string;
  sourceFilePath: string;
  policy: RightsPolicy;
}

interface VerifyRightsRequest {
  assetId: string;
  action: RightsAction;
}

interface ExecuteActionRequest {
  assetId: string;
  action: ProvenanceAction;
  derivedAssetId: string;
  usageAmount?: number;
}

/*
 * DAY 10 DEMO ROYALTY RULE
 *
 * These are recipient identifiers, NOT blockchain
 * wallet addresses and NOT payment destinations.
 *
 * The first royalty milestone proves deterministic
 * allocation only. No funds are transferred.
 *
 * Real Solana Devnet recipient addresses can replace
 * these identifiers in the main demo.
 */
const DEMO_ROYALTY_RULE: RoyaltyRule = {
  royaltyRuleId: "relaystream-demo-royalty-rule-001",
  assetId: "relaystream-demo-001",
  currency: "USD-DEMO",
  recipients: [
    {
      role: "creator",
      wallet: "3Ywmj3aKMe2Ti5wSz4x2mfZ2GJJdC8HpdXnbunPB4bQA",
      percentage: 60,
    },
    {
      role: "rightsholder",
      wallet: "84ybGHDF7zPAr5aa8Hx3xS4wRZ6u2S5LPvtUdPuPBKfH",
      percentage: 20,
    },
    {
      role: "distributor",
      wallet: "GuYsfNxu29BZBa32FSJf2URodPK617uwUX63mUudPPzn",
      percentage: 10,
    },
    {
      role: "infrastructure",
      wallet: "nQGn7dXP1hN7XzJ7zP3UtML3HfUuGCtNipgmtL4j8ZZ",
      percentage: 10,
    },
  ],
};

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  });

  response.end(
    JSON.stringify(body, null, 2)
  );
}

async function readJsonBody(
  request: IncomingMessage
): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk)
    );
  }

  const body = Buffer.concat(chunks)
    .toString("utf8")
    .trim();

  if (!body) {
    return {};
  }

  return JSON.parse(body);
}

function isRightsAction(
  value: unknown
): value is RightsAction {
  return (
    value === "commercialUse" ||
    value === "aiTraining" ||
    value === "derivatives" ||
    value === "transcoding"
  );
}

function isProvenanceAction(
  value: unknown
): value is ProvenanceAction {
  return (
    value === "derivatives" ||
    value === "transcoding"
  );
}

const server = http.createServer(
  async (request, response) => {
    try {
      const method =
        request.method ?? "GET";

      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`
      );

      /*
       * HEALTH
       */
      if (
        method === "GET" &&
        url.pathname === "/health"
      ) {
        sendJson(response, 200, {
          service:
            "RelayStream Rights API",
          status: "online",
          network: "solana-devnet",
          registeredAssets:
            assets.size,
          royaltyEngine:
            "deterministic-allocation",
          paymentsEnabled: false,
        });

        return;
      }

      /*
       * MEDIA REGISTRATION
       */
      if (
        method === "POST" &&
        url.pathname === "/media/register"
      ) {
        const body =
          await readJsonBody(request) as
            Partial<RegisterRequest>;

        if (
          !body.assetId ||
          !body.title ||
          !body.owner ||
          !body.sourceUri ||
          !body.sourceFilePath ||
          !body.policy
        ) {
          sendJson(response, 400, {
            error:
              "Missing required media registration fields.",
          });

          return;
        }

        const resolvedFilePath =
          path.resolve(
            body.sourceFilePath
          );

        const asset = registerMedia({
          assetId: body.assetId,
          title: body.title,
          owner: body.owner,
          sourceUri:
            body.sourceUri,
          sourceFilePath:
            resolvedFilePath,
          policy: body.policy,
        });

        assets.set(
          asset.assetId,
          asset
        );

        sendJson(response, 201, {
          status: "registered",

          asset: {
            assetId:
              asset.assetId,
            title:
              asset.title,
            owner:
              asset.owner,
            sourceUri:
              asset.sourceUri,
            sourceSizeBytes:
              asset.sourceSizeBytes,
            hashAlgorithm:
              asset.hashAlgorithm,
            sourceContentHash:
              asset.sourceContentHash,
            policyId:
              asset.policy.policyId,
            policyHash:
              asset.policyHash,
          },
        });

        return;
      }

      /*
       * RIGHTS VERIFICATION
       */
      if (
        method === "POST" &&
        url.pathname === "/rights/verify"
      ) {
        const body =
          await readJsonBody(request) as
            Partial<VerifyRightsRequest>;

        if (
          !body.assetId ||
          !isRightsAction(
            body.action
          )
        ) {
          sendJson(response, 400, {
            error:
              "assetId and a valid action are required.",
          });

          return;
        }

        const asset =
          assets.get(
            body.assetId
          );

        if (!asset) {
          sendJson(response, 404, {
            error:
              "Asset not registered.",
            assetId:
              body.assetId,
          });

          return;
        }

        const result =
          verifyPermission(
            asset,
            body.action
          );

        sendJson(response, 200, {
          status:
            result.authorized
              ? "authorized"
              : "blocked",

          assetId:
            result.assetId,

          policyId:
            result.policyId,

          policyHash:
            asset.policyHash,

          action:
            result.action,

          decision:
            result.decision,

          authorized:
            result.authorized,

          attributionRequired:
            result.attributionRequired,

          provenanceRequired:
            result.provenanceRequired,

          reason:
            result.reason,
        });

        return;
      }

      /*
       * AUTHORIZED ACTION EXECUTION
       *
       * Pipeline:
       *
       * rights verification
       *        ->
       * authorized transformation request
       *        ->
       * provenance record
       *        ->
       * SHA-256 provenance proof
       *        ->
       * Solana Devnet anchor
       *        ->
       * confirmed transaction
       *        ->
       * deterministic royalty event
       *        ->
       * SHA-256 royalty proof
       *
       * IMPORTANT:
       *
       * The prototype authorizes the requested
       * transformation and records provenance.
       *
       * It does NOT perform an actual media
       * transcode or derivative generation.
       *
       * The royalty layer calculates allocation.
       * It does NOT transfer funds.
       */
      if (
        method === "POST" &&
        url.pathname ===
          "/actions/execute"
      ) {
        const body =
          await readJsonBody(request) as
            Partial<ExecuteActionRequest>;

        if (
          !body.assetId ||
          !body.derivedAssetId ||
          !isProvenanceAction(
            body.action
          )
        ) {
          sendJson(response, 400, {
            error:
              "assetId, derivedAssetId, and a valid provenance action are required.",

            validActions: [
              "derivatives",
              "transcoding",
            ],
          });

          return;
        }

        const asset =
          assets.get(
            body.assetId
          );

        if (!asset) {
          sendJson(response, 404, {
            error:
              "Asset not registered.",

            assetId:
              body.assetId,
          });

          return;
        }

        /*
         * STEP 1
         *
         * Rights authorization happens BEFORE
         * provenance, blockchain anchoring,
         * or economic allocation.
         */
        const rightsResult =
          verifyPermission(
            asset,
            body.action
          );

        if (
          !rightsResult.authorized
        ) {
          sendJson(response, 403, {
            status: "blocked",

            assetId:
              asset.assetId,

            policyId:
              asset.policy.policyId,

            policyHash:
              asset.policyHash,

            action:
              body.action,

            decision:
              rightsResult.decision,

            authorized: false,

            provenanceCreated:
              false,

            solanaAnchored:
              false,

            royaltyEventCreated:
              false,

            royaltyAllocated:
              false,

            allocatedAmount:
              0,

            reason:
              rightsResult.reason,
          });

          return;
        }

        /*
         * STEP 2
         *
         * Create provenance for the authorized
         * transformation request.
         */
        const proof =
          executeAuthorizedTransformation(
            asset,
            body.action,
            body.derivedAssetId
          );

        if (!proof) {
          sendJson(response, 403, {
            status: "blocked",

            assetId:
              asset.assetId,

            action:
              body.action,

            authorized: false,

            provenanceCreated:
              false,

            solanaAnchored:
              false,

            royaltyEventCreated:
              false,

            royaltyAllocated:
              false,

            allocatedAmount:
              0,

            error:
              "Authorized transformation did not create provenance.",
          });

          return;
        }

        /*
         * STEP 3
         *
         * Anchor the exact provenance SHA-256
         * proof to Solana Devnet.
         */
        const anchor =
          await anchorProvenanceProof(
            proof.provenanceHash
          );

        /*
         * STEP 4
         *
         * Create a deterministic royalty event
         * only AFTER:
         *
         * - rights authorization
         * - provenance creation
         * - provenance proof
         * - confirmed Solana anchor
         *
         * Default demo usage value is 100.
         */
        const usageAmount =
          body.usageAmount ?? 100;

        const royaltyEvent =
          createRoyaltyEvent({
            assetId:
              asset.assetId,

            action:
              body.action,

            derivedAssetId:
              body.derivedAssetId,

            provenanceId:
              proof.record.provenanceId,

            provenanceHash:
              proof.provenanceHash,

            solanaSignature:
              anchor.signature,

            authorized: true,

            usageAmount,

            royaltyRule:
              DEMO_ROYALTY_RULE,
          });

        /*
         * STEP 5
         *
         * Cryptographically fingerprint the
         * exact royalty event.
         */
        const royaltyProof =
          hashRoyaltyEvent(
            royaltyEvent
          );

        /*
         * STEP 6
         *
         * Return the complete result to the
         * calling application.
         */
        sendJson(response, 200, {
          status: "authorized",

          assetId:
            asset.assetId,

          derivedAssetId:
            body.derivedAssetId,

          policyId:
            asset.policy.policyId,

          policyHash:
            asset.policyHash,

          action:
            body.action,

          decision: "allow",

          authorized: true,

          provenanceCreated: true,

          provenance: {
            provenanceId:
              proof.record.provenanceId,

            sourceAssetId:
              proof.record.sourceAssetId,

            derivedAssetId:
              proof.record.derivedAssetId,

            policyId:
              proof.record.policyId,

            policyHash:
              proof.record.policyHash,

            action:
              proof.record.action,

            owner:
              proof.record.owner,

            sourceContentHash:
              proof.record.sourceContentHash,

            createdAt:
              proof.record.createdAt,
          },

          proof: {
            hashAlgorithm:
              proof.hashAlgorithm,

            provenanceHash:
              proof.provenanceHash,
          },

          solana: {
            anchored: true,
            network: "devnet",
            commitment:
              "confirmed",

            signature:
              anchor.signature,

            signer:
              anchor.signer,

            memo:
              anchor.memo,

            provenanceHash:
              anchor.provenanceHash,
          },

          royalty: {
            eventCreated: true,

            allocationOnly: true,

            fundsTransferred: false,

            royaltyEventId:
              royaltyEvent.royaltyEventId,

            royaltyRuleId:
              royaltyEvent.royaltyRuleId,

            currency:
              royaltyEvent.currency,

            usageAmount:
              royaltyEvent.usageAmount,

            totalAllocated:
              royaltyEvent.totalAllocated,

            allocations:
              royaltyEvent.allocations,

            provenanceId:
              royaltyEvent.provenanceId,

            provenanceHash:
              royaltyEvent.provenanceHash,

            solanaSignature:
              royaltyEvent.solanaSignature,

            createdAt:
              royaltyEvent.createdAt,

            proof:
              royaltyProof,
          },
        });

        return;
      }

      /*
       * ROUTE NOT FOUND
       */
      sendJson(response, 404, {
        error:
          "Route not found.",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown server error.";

      sendJson(response, 500, {
        error: message,
      });
    }
  }
);

server.listen(PORT, () => {
  console.log(
    "\n======================================"
  );

  console.log(
    "RELAYSTREAM RIGHTS API"
  );

  console.log(
    "======================================"
  );

  console.log(
    "STATUS: ONLINE"
  );

  console.log(
    `PORT: ${PORT}`
  );

  console.log(
    "NETWORK: SOLANA DEVNET"
  );

  console.log(
    "ROYALTY ENGINE: ALLOCATION ONLY"
  );

  console.log(
    "PAYMENTS: DISABLED"
  );

  console.log("");

  console.log(
    "GET  /health"
  );

  console.log(
    "POST /media/register"
  );

  console.log(
    "POST /rights/verify"
  );

  console.log(
    "POST /actions/execute"
  );

  console.log(
    "======================================"
  );
});