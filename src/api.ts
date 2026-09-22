import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import {
  verifyPermission,
} from "./index";

import {
  registerMedia,
  type RegisteredMediaAsset,
  type RightsAction,
  type RightsPolicy,
} from "./register-media";

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

const server = http.createServer(
  async (request, response) => {
    try {
      const method = request.method ?? "GET";

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
          service: "RelayStream Rights API",
          status: "online",
          network: "solana-devnet",
          registeredAssets: assets.size,
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
          path.resolve(body.sourceFilePath);

        const asset = registerMedia({
          assetId: body.assetId,
          title: body.title,
          owner: body.owner,
          sourceUri: body.sourceUri,
          sourceFilePath: resolvedFilePath,
          policy: body.policy,
        });

        assets.set(
          asset.assetId,
          asset
        );

        sendJson(response, 201, {
          status: "registered",
          asset: {
            assetId: asset.assetId,
            title: asset.title,
            owner: asset.owner,
            sourceUri: asset.sourceUri,
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
          !isRightsAction(body.action)
        ) {
          sendJson(response, 400, {
            error:
              "assetId and a valid action are required.",
          });

          return;
        }

        const asset =
          assets.get(body.assetId);

        if (!asset) {
          sendJson(response, 404, {
            error: "Asset not registered.",
            assetId: body.assetId,
          });

          return;
        }

        const result =
          verifyPermission(
            asset,
            body.action
          );

        sendJson(response, 200, {
          status: result.authorized
            ? "authorized"
            : "blocked",
          assetId: result.assetId,
          policyId: result.policyId,
          policyHash: asset.policyHash,
          action: result.action,
          decision: result.decision,
          authorized: result.authorized,
          attributionRequired:
            result.attributionRequired,
          provenanceRequired:
            result.provenanceRequired,
          reason: result.reason,
        });

        return;
      }

      sendJson(response, 404, {
        error: "Route not found.",
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
  console.log("\n======================================");
  console.log("RELAYSTREAM RIGHTS API");
  console.log("======================================");
  console.log("STATUS: ONLINE");
  console.log(`PORT: ${PORT}`);
  console.log("NETWORK: SOLANA DEVNET");
  console.log("");
  console.log("GET  /health");
  console.log("POST /media/register");
  console.log("POST /rights/verify");
  console.log("======================================");
});