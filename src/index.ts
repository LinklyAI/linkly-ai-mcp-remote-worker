/**
 * Linkly AI MCP Remote Worker
 *
 * This Cloudflare Worker exposes local MCP servers to the internet via WebSocket tunnel.
 * Users deploy their own instance of this worker, then connect their desktop app to it.
 *
 * Architecture:
 *   Remote MCP Client → Worker (HTTPS) → Durable Object → WebSocket → Desktop App → Local MCP Server
 *
 * Endpoints:
 *   GET  /         - Worker info
 *   GET  /health   - Health check (shows tunnel status)
 *   GET  /tunnel   - WebSocket endpoint for desktop connection
 *   POST /mcp      - MCP endpoint for remote clients
 */

// Re-export Durable Object class for Cloudflare runtime
export { McpTunnel } from './tunnel.js';

export default {
	/**
	 * Main fetch handler - routes all requests to the Durable Object
	 */
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		// CORS headers for cross-origin requests
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id',
		};

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// Single tunnel per worker instance (user self-deployed)
			// Using 'default' as the ID since each user has their own worker
			const id = env.MCP_TUNNEL.idFromName('default');
			const stub = env.MCP_TUNNEL.get(id);

			// Forward request to Durable Object
			const response = await stub.fetch(request);

			// Add CORS headers to response
			const newHeaders = new Headers(response.headers);
			Object.entries(corsHeaders).forEach(([key, value]) => {
				newHeaders.set(key, value);
			});

			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: newHeaders,
			});
		} catch (error) {
			console.error(`Worker error: ${error}`);
			return new Response(
				JSON.stringify({
					error: 'Internal server error',
					message: error instanceof Error ? error.message : 'Unknown error',
				}),
				{
					status: 500,
					headers: {
						'Content-Type': 'application/json',
						...corsHeaders,
					},
				}
			);
		}
	},
} satisfies ExportedHandler<Env>;
