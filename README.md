# Linkly AI MCP Remote Worker

Expose your Linkly AI Desktop local MCP (Model Context Protocol) server to the internet via Cloudflare Workers.

This worker acts as a reverse proxy, allowing remote MCP clients (like ChatGPT, Claude, etc.) to access your local MCP server running on your desktop through a secure WebSocket tunnel.

## Architecture

```
Remote MCP Client (ChatGPT/Claude...)
    ↓ HTTPS POST /mcp
Your Cloudflare Worker
    ↓ WebSocket (Hibernatable)
Durable Object (Tunnel Manager)
    ↑ WebSocket (Long-lived connection)
Linkly AI Desktop App
    ↓ HTTP
Local MCP Server (127.0.0.1:60606/mcp)
```

## Deploy

### One-Click Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/linkly-ai/linkly-ai-mcp-remote-worker)

### Manual Deploy

1. Clone this repository:

   ```bash
   git clone https://github.com/linkly-ai/linkly-ai-mcp-remote-worker.git
   cd linkly-ai-mcp-remote-worker
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Login to Cloudflare:

   ```bash
   npx wrangler login
   ```

4. Deploy the worker:

   ```bash
   pnpm run deploy
   ```

5. Note down your worker URL (e.g., `https://linkly-ai-mcp-remote.<your-account>.workers.dev`)

## Usage

### Configure Linkly AI Desktop

1. Open Linkly AI Desktop
2. Go to **Settings** → **MCP** tab
3. Enter your worker URL (without `https://` prefix)
4. Click **Test** to verify the connection
5. Click **Save** to save the configuration
6. Enable the tunnel switch on the MCP page

### Configure MCP Clients

Once the tunnel is connected, configure your MCP client to use the remote endpoint:

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
	"mcpServers": {
		"linkly-ai": {
			"url": "https://linkly-ai-mcp-remote.<your-account>.workers.dev/mcp"
		}
	}
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
	"mcpServers": {
		"linkly-ai": {
			"url": "https://linkly-ai-mcp-remote.<your-account>.workers.dev/mcp"
		}
	}
}
```

## API Endpoints

| Endpoint  | Method | Description                           |
| --------- | ------ | ------------------------------------- |
| `/`       | GET    | Worker info and available endpoints   |
| `/health` | GET    | Health check (shows tunnel status)    |
| `/tunnel` | GET    | WebSocket endpoint for desktop tunnel |
| `/mcp`    | POST   | MCP endpoint for remote clients       |

## Development

### Local Development

```bash
pnpm run dev
```

This starts a local development server at `http://localhost:8787`.

### Generate Types

```bash
pnpm run cf-typegen
```

### Run Tests

```bash
pnpm test
```

## How It Works

1. **Desktop Connection**: Your Linkly AI Desktop app connects to the worker via WebSocket at `/tunnel`
2. **Hibernation**: The Durable Object can hibernate during idle periods, reducing costs while keeping the WebSocket alive
3. **MCP Proxy**: When a remote MCP client sends a request to `/mcp`, the worker forwards it through the WebSocket to your desktop
4. **Local Forwarding**: Your desktop app receives the request and forwards it to your local MCP server
5. **Response Path**: The response travels back through the same path

## Security Considerations

- **No Authentication**: The current version has no authentication. Your worker URL acts as a simple access control.
- **Self-Deployed**: Each user deploys their own worker instance, providing isolation.
- **HTTPS Only**: All communications use HTTPS/WSS encryption.

For production use, consider adding authentication via Cloudflare Access or API keys.

## Cost

This worker uses Cloudflare Durable Objects with WebSocket Hibernation, which is cost-effective:

- **Workers**: Free tier includes 100,000 requests/day
- **Durable Objects**: Pay-as-you-go, but hibernation minimizes active time
- **WebSocket**: Auto ping/pong doesn't wake the Durable Object

Typical personal usage should stay within free tier limits.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [Linkly AI Desktop](https://linkly.ai) - AI-powered knowledge management desktop app
- [Model Context Protocol](https://modelcontextprotocol.io/) - Open protocol for AI model context
