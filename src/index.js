import express from 'express'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import OpenAI from 'openai'
import dotenv from 'dotenv'
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import fs from 'fs/promises'
import { Server } from 'socket.io'
import swaggerUi from 'swagger-ui-express'
import swaggerJsdoc from 'swagger-jsdoc'
import cors from 'cors'

// Load environment variables
dotenv.config()

// Swagger definition
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MCP API',
      version: '1.0.0',
      description: 'API documentation for the Model Context Protocol (MCP) server',
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3005}`,
        description: 'Development server',
      },
    ],
  },
  apis: ['./src/index.js'], // Path to the API docs
}

const swaggerSpec = swaggerJsdoc(swaggerOptions)

// MCP Client Manager
class MCPClientManager {
  constructor() {
    this.clients = new Map()
    this.serverConfigs = {}
    this.toolMapping = new Map()
  }

  async loadServerConfigs() {
    try {
      // Try loading from different possible config locations
      const configPaths = [
        // Claude desktop config
        join(process.env.HOME || process.env.USERPROFILE, '.config', 'claude', 'claude_desktop_config.json'),
        // Custom config location from env
        process.env.MCP_CONFIG_PATH,
        // Local config file
        join(process.cwd(), 'mcp_config.json')
      ]

      for (const path of configPaths) {
        if (!path) continue

        try {
          const configData = await fs.readFile(path, 'utf-8')
          const config = JSON.parse(configData)

          if (config.mcpServers) {
            console.log(`Loaded MCP server configs from ${path}`)
            this.serverConfigs = config.mcpServers
            break
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            console.error(`Error reading config from ${path}:`, err)
          }
        }
      }

      if (Object.keys(this.serverConfigs).length === 0) {
        throw new Error('No MCP server configurations found')
      }
    } catch (error) {
      console.error('Failed to load server configurations:', error)
      throw error
    }
  }

  async connectToAllServers() {
    const connectedClients = []

    for (const [serverId, config] of Object.entries(this.serverConfigs)) {
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: {
            ...process.env,  // Include existing env variables
            ...(config.env || {})  // Include server-specific env variables
          }
        })

        const client = new Client({
          name: "mcp-chat-client",
          version: "1.0.0",
        }, {
          capabilities: {}
        })

        await client.connect(transport)
        this.clients.set(serverId, client)

        console.log(`Connected to MCP server: ${serverId}`)
        connectedClients.push({ serverId, client })
      } catch (error) {
        console.error(`Failed to connect to MCP server ${serverId}:`, error)
      }
    }

    if (connectedClients.length === 0) {
      throw new Error('Failed to connect to any MCP servers')
    }

    return connectedClients
  }

  async getAllTools() {
    const allTools = []
    this.toolMapping.clear()

    for (const [serverId, client] of this.clients.entries()) {
      try {
        const tools = await client.listTools()
        if (tools?.tools) {
          // Convert MCP tools to OpenAI tool format with valid names
          const openAITools = tools.tools.map(tool => {
            // Create a valid OpenAI function name
            const openAIName = `${serverId}_${tool.name}`
            // Store the mapping
            this.toolMapping.set(openAIName, {
              serverId,
              toolName: tool.name
            })

            return {
              type: 'function',
              function: {
                name: openAIName,
                description: tool.description,
                parameters: tool.inputSchema
              }
            }
          })
          allTools.push(...openAITools)
        }
      } catch (error) {
        console.error(`Failed to list tools for ${serverId}:`, error)
      }
    }

    return allTools
  }

  async callTool(openAIName, args) {
    console.log(`Calling tool: ${openAIName} with args: ${JSON.stringify(args)}`)
    const tools = await this.getAllTools()
    console.log(`Tools: ${JSON.stringify(tools)}`)
    console.log(`Tool mapping: ${JSON.stringify([...this.toolMapping.entries()])}`)
    
    const toolInfo = this.toolMapping.get(openAIName)
    if (!toolInfo) {
      throw new Error(`Unknown tool: ${openAIName}. Available tools: ${[...this.toolMapping.keys()].join(', ')}`)
    }

    console.log(`Tool info: ${JSON.stringify(toolInfo)}`)

    const { serverId, toolName } = toolInfo
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`Server ${serverId} not found`)
    }

    return client.callTool({
      name: toolName,
      arguments: args
    })
  }
}

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer)
const mcpManager = new MCPClientManager()

async function main() {
  // Initialize MCP manager and get tools
  await mcpManager.loadServerConfigs()
  await mcpManager.connectToAllServers()
}

main()

// Enable CORS
app.use(cors())

// Serve static files
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public')))
app.use(express.json())

// Swagger UI setup
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))

/**
 * @swagger
 * /tools/{toolType}:
 *   get:
 *     summary: Get available tools by type
 *     description: Retrieve a list of available tools filtered by type (mcp or openai)
 *     parameters:
 *       - in: path
 *         name: toolType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [mcp, openai]
 *         description: The type of tools to retrieve
 *     responses:
 *       200:
 *         description: A list of tools
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   type:
 *                     type: string
 *                     example: function
 *                   function:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: server_toolName
 *                       description:
 *                         type: string
 *                         example: Tool description
 *                       parameters:
 *                         type: object
 *       400:
 *         description: Invalid tool type provided
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Invalid tool type. Must be "mcp" or "openai"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to get tools
 */
app.get('/tools/:toolType', async (req, res) => {
  try {
    const { toolType } = req.params
    const tools = await mcpManager.getAllTools()

    if (toolType === 'mcp') {
      res.json(tools)
    } else if (toolType === 'openai') {
      const openAITools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: {
            type: 'object',
            properties: tool.function.parameters.properties || {}
          }
        }
      }))
      res.json(openAITools)
    } else {
      res.status(400).json({ error: 'Invalid tool type. Must be "mcp" or "openai"' })
    }
  } catch (error) {
    console.error('Error getting tools:', error)
    res.status(500).json({ error: 'Failed to get tools' })
  }
})

/**
 * @swagger
 * /callTool:
 *   post:
 *     summary: Call a specific tool with arguments
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - toolName
 *             properties:
 *               toolName:
 *                 type: string
 *                 description: Full tool name in format "serverName_toolName"
 *                 example: mac-apps-launcher_launch_app
 *               arguments:
 *                 type: object
 *                 description: Arguments to pass to the tool
 *                 example: {"appName": "Music"}
 *     responses:
 *       200:
 *         description: Tool executed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Tool execution result
 *       404:
 *         description: Server or tool not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Server or tool not found
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to execute tool
 */
app.post('/callTool', async (req, res) => {
  try {
    const { toolName, arguments: args } = req.body

    // Convert any spaces to underscores in toolName
    const normalizedToolName = toolName.replace(/\s+/g, '_')
    
    // Get all server names from mcpManager
    const serverNames = Array.from(mcpManager.clients.keys())

    console.log(`Server names: ${serverNames}`)
    
    // Find the matching server and tool name
    let matchingServer = null
    let actualToolName = null
    
    for (const serverName of serverNames) {
      // Replace spaces with underscores in server name for comparison
      const normalizedServerName = serverName.replace(/\s+/g, '_')
      if (normalizedToolName.startsWith(normalizedServerName + '_')) {
        matchingServer = serverName
        actualToolName = normalizedToolName
        break
      }
    }

    if (!matchingServer || !actualToolName) {
      return res.status(404).json({ error: 'Server not found for the given tool name' })
    }
    
    const result = await mcpManager.callTool(toolName, args)
    res.json(result)
  } catch (error) {
    console.error('Error executing tool:', error)
    res.status(500).json({ error: error.message || 'Failed to execute tool' })
  }
})

/**
 * @swagger
 * components:
 *   schemas:
 *     Tool:
 *       type: object
 *       properties:
 *         type:
 *           type: string
 *           description: The type of the tool
 *           example: function
 *         function:
 *           type: object
 *           properties:
 *             name:
 *               type: string
 *               description: The name of the tool
 *               example: server_toolName
 *             description:
 *               type: string
 *               description: Description of what the tool does
 *             parameters:
 *               type: object
 *               description: JSON Schema of the tool's parameters
 */



// Start web server
const PORT = process.env.PORT || 3005
httpServer.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`)
}) 