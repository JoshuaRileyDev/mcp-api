# MCP API

  

A Node.js server that manages multiple Model Context Protocol (MCP) servers and exposes their tools via a REST API.

  

## Features

  

- Connects to multiple MCP servers defined in configuration

- Exposes server tools via REST API endpoints

- Swagger documentation at `/api-docs`

- Tool name normalization and mapping between OpenAI and MCP formats

## Installation

Clone the repository and then run the follow command:

    npm i && npm run dev

Rename .env.example file to .env and update the environment variable to be the full local path to your MCP config.json file
  

## Usage

  This spins up an ExpressJS server on port 3005

### GET /tools/:toolType

  

Retrieves an array of all tools

  

Use /tools/mcp for the MCP format or use /tools/openai for the OpenAI format for how a tool function is structured.

  

### POST /callTool

  

Executes a tool function call.

  

Request body:

    {
	    "toolName":"toolname",
	    "arguments":{}
	}

The output will be the result from the tool
