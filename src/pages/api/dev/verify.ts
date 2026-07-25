import { matchDevCredential } from "@utils/dev-auth-server";
import type { APIRoute } from "astro";

export const prerender = false;

function json(status: number, payload: Record<string, unknown>) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

type VerifyPayload = {
	devCode?: string;
	devCodeHash?: string;
};

async function readVerifyPayload(request: Request): Promise<VerifyPayload> {
	const url = new URL(request.url);
	const urlCode = url.searchParams.get("devCode") || "";
	const urlCodeHash = url.searchParams.get("devCodeHash") || "";
	if (urlCode || urlCodeHash) {
		return {
			devCode: urlCode,
			devCodeHash: urlCodeHash,
		};
	}

	const raw = await request.text();
	if (!raw) return {};

	try {
		const parsed = JSON.parse(raw) as {
			devCode?: unknown;
			devCodeHash?: unknown;
		};
		return {
			devCode: typeof parsed.devCode === "string" ? parsed.devCode : "",
			devCodeHash:
				typeof parsed.devCodeHash === "string" ? parsed.devCodeHash : "",
		};
	} catch {
		const params = new URLSearchParams(raw);
		return {
			devCode: params.get("devCode") || "",
			devCodeHash: params.get("devCodeHash") || "",
		};
	}
}

function isValidPayload(payload: VerifyPayload, expectedCode: string): boolean {
	return matchDevCredential({
		devCode: payload.devCode,
		devCodeHash: payload.devCodeHash,
		expectedCode,
	});
}

export const POST: APIRoute = async ({ request }) => {
	const expectedCode = import.meta.env.DEV_EDITOR_CODE;
	if (!expectedCode) {
		return json(500, { ok: false, message: "Server misconfigured: DEV_EDITOR_CODE not set" });
	}
	try {
		const payload = await readVerifyPayload(request);
		if (!(payload.devCode || payload.devCodeHash)) {
			return json(400, { ok: false, message: "Missing code" });
		}
		if (!isValidPayload(payload, expectedCode)) {
			return json(403, { ok: false, message: "Invalid code" });
		}
		return json(200, { ok: true });
	} catch {
		return json(400, { ok: false, message: "Invalid request format" });
	}
};

export const GET: APIRoute = async ({ request }) => {
	const expectedCode = import.meta.env.DEV_EDITOR_CODE;
	if (!expectedCode) {
		return json(500, { ok: false, message: "Server misconfigured: DEV_EDITOR_CODE not set" });
	}
	const url = new URL(request.url);
	const payload: VerifyPayload = {
		devCode: url.searchParams.get("devCode") || "",
		devCodeHash: url.searchParams.get("devCodeHash") || "",
	};
	if (!(payload.devCode || payload.devCodeHash)) {
		return json(400, { ok: false, message: "Missing code" });
	}
	if (!isValidPayload(payload, expectedCode)) {
		return json(403, { ok: false, message: "Invalid code" });
	}
	return json(200, { ok: true });
};
