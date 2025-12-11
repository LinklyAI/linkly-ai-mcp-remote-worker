/**
 * MCP Tunnel Durable Object
 *
 * Manages WebSocket connection from desktop app and proxies MCP requests
 * from remote clients to the desktop's local MCP server.
 *
 * Uses WebSocket Hibernation API to reduce costs during idle periods.
 */

import { DurableObject } from 'cloudflare:workers';

/**
 * Message protocol between desktop and worker
 */
interface TunnelMessage {
	type: 'connect' | 'connected' | 'request' | 'response' | 'error';
	id?: string;
	payload?: unknown;
	remoteEndpoint?: string;
	error?: string;
}

/**
 * MCP request payload forwarded to desktop
 */
interface McpRequestPayload {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
}

/**
 * MCP response payload from desktop
 */
interface McpResponsePayload {
	status: number;
	headers?: Record<string, string>;
	body: string;
}

/**
 * Pending request waiting for desktop response
 */
interface PendingRequest {
	resolve: (response: McpResponsePayload) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

/**
 * MCP Tunnel Durable Object
 *
 * Single tunnel per worker instance (user self-deployed).
 * Handles WebSocket connection from desktop and HTTP requests from MCP clients.
 */
export class McpTunnel extends DurableObject<Env> {
	/** Desktop WebSocket connection (restored from hibernation via tag) */
	private desktopWs: WebSocket | null = null;

	/** Pending MCP requests waiting for desktop response */
	private pendingRequests: Map<string, PendingRequest> = new Map();

	/** Request timeout in milliseconds */
	private readonly REQUEST_TIMEOUT = 30000;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		// Restore WebSocket connection after hibernation
		const sockets = this.ctx.getWebSockets('desktop');
		if (sockets.length > 0) {
			this.desktopWs = sockets[0];
		}

		// Set up auto ping/pong response (won't wake DO from hibernation)
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	/**
	 * Handle incoming HTTP requests
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Health check endpoint
		if (url.pathname === '/health') {
			return this.handleHealthCheck();
		}

		// Desktop WebSocket tunnel connection
		if (url.pathname === '/tunnel') {
			return this.handleDesktopConnect(request);
		}

		// Remote MCP requests
		if (url.pathname === '/mcp') {
			return this.handleMcpRequest(request);
		}

		// Default response
		return new Response(
			JSON.stringify({
				name: 'linkly-ai-mcp-remote',
				version: '0.1.0',
				endpoints: {
					health: '/health',
					tunnel: '/tunnel (WebSocket)',
					mcp: '/mcp (POST)',
				},
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	}

	/**
	 * Health check endpoint for connection testing
	 */
	private handleHealthCheck(): Response {
		const isConnected = this.desktopWs !== null && this.desktopWs.readyState === WebSocket.OPEN;

		return new Response(
			JSON.stringify({
				status: 'ok',
				tunnel: isConnected ? 'connected' : 'disconnected',
				timestamp: new Date().toISOString(),
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	}

	/**
	 * Handle desktop WebSocket connection
	 */
	private handleDesktopConnect(request: Request): Response {
		// Verify WebSocket upgrade request
		const upgradeHeader = request.headers.get('Upgrade');
		if (upgradeHeader !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 426 });
		}

		// Close existing connection if any
		if (this.desktopWs && this.desktopWs.readyState === WebSocket.OPEN) {
			this.desktopWs.close(1000, 'New connection replacing old one');
		}

		// Create WebSocket pair
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Accept WebSocket with hibernation support
		// Tag 'desktop' allows us to restore the connection after hibernation
		this.ctx.acceptWebSocket(server, ['desktop']);
		this.desktopWs = server;

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	/**
	 * Handle MCP request from remote client
	 */
	private async handleMcpRequest(request: Request): Promise<Response> {
		// Check if desktop is connected
		if (!this.desktopWs || this.desktopWs.readyState !== WebSocket.OPEN) {
			return new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					error: {
						code: -32000,
						message: 'Desktop is not connected',
					},
				}),
				{
					status: 503,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}

		// Generate unique request ID
		const requestId = crypto.randomUUID();

		// Extract request details
		const body = await request.text();
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			// Forward relevant headers
			if (!['host', 'connection', 'upgrade'].includes(key.toLowerCase())) {
				headers[key] = value;
			}
		});

		// Create request payload
		const mcpRequest: McpRequestPayload = {
			method: request.method,
			url: request.url,
			headers,
			body,
		};

		// Send request to desktop
		const message: TunnelMessage = {
			type: 'request',
			id: requestId,
			payload: mcpRequest,
		};

		try {
			// Create promise that resolves when desktop responds
			const responsePromise = new Promise<McpResponsePayload>((resolve, reject) => {
				const timeout = setTimeout(() => {
					this.pendingRequests.delete(requestId);
					reject(new Error('Request timeout'));
				}, this.REQUEST_TIMEOUT);

				this.pendingRequests.set(requestId, { resolve, reject, timeout });
			});

			// Send request to desktop
			this.desktopWs.send(JSON.stringify(message));

			// Wait for response
			const response = await responsePromise;

			// Build response headers
			const responseHeaders = new Headers(response.headers);
			responseHeaders.set('Content-Type', 'application/json');

			return new Response(response.body, {
				status: response.status,
				headers: responseHeaders,
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					error: {
						code: -32000,
						message: errorMessage,
					},
				}),
				{
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}
	}

	/**
	 * WebSocket message handler (called by runtime, supports hibernation)
	 */
	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
		try {
			const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
			const msg: TunnelMessage = JSON.parse(data);

			switch (msg.type) {
				case 'connect':
					// Desktop connected, send confirmation with remote endpoint
					this.handleDesktopConnected(ws);
					break;

				case 'response':
					// Desktop responded to MCP request
					if (msg.id && msg.payload) {
						this.handleMcpResponse(msg.id, msg.payload as McpResponsePayload);
					}
					break;

				default:
					console.log(`Unknown message type: ${msg.type}`);
			}
		} catch (error) {
			console.error(`Failed to handle WebSocket message: ${error}`);
		}
	}

	/**
	 * Handle desktop connection confirmation
	 */
	private handleDesktopConnected(ws: WebSocket): void {
		// Get the worker URL from request (we'll use the origin)
		// Since we're in a DO, we need to construct the endpoint URL
		const remoteEndpoint = '/mcp'; // Relative path, desktop will construct full URL

		const response: TunnelMessage = {
			type: 'connected',
			remoteEndpoint,
		};

		ws.send(JSON.stringify(response));
		console.log('Desktop connected, tunnel established');
	}

	/**
	 * Handle MCP response from desktop
	 */
	private handleMcpResponse(requestId: string, payload: McpResponsePayload): void {
		const pending = this.pendingRequests.get(requestId);
		if (pending) {
			clearTimeout(pending.timeout);
			this.pendingRequests.delete(requestId);
			pending.resolve(payload);
		}
	}

	/**
	 * WebSocket close handler (called by runtime, supports hibernation)
	 */
	async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
		console.log(`WebSocket closed: ${code} - ${reason}`);

		// Clear desktop connection if this was the desktop socket
		if (ws === this.desktopWs) {
			this.desktopWs = null;

			// Reject all pending requests
			for (const [id, pending] of this.pendingRequests) {
				clearTimeout(pending.timeout);
				pending.reject(new Error('Desktop disconnected'));
				this.pendingRequests.delete(id);
			}
		}
	}

	/**
	 * WebSocket error handler (called by runtime, supports hibernation)
	 */
	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		console.error(`WebSocket error: ${error}`);
	}
}
