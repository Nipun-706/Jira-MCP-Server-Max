const fs = require('fs');
const { spawn } = require('child_process');

// Read the bulk stories JSON
const bulkData = JSON.parse(fs.readFileSync('./bulk_stories.json', 'utf8'));

// Create MCP request
const mcpRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "create_issues_bulk",
    arguments: bulkData
  }
};

console.log('Sending bulk creation request...');
console.log(JSON.stringify(mcpRequest, null, 2));

// You would send this to your MCP server
// This is just a demonstration of the request format
