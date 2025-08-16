#!/usr/bin/env node

import * as dotenv from 'dotenv';
dotenv.config();

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import JiraClient from "jira-client";

const DEFAULT_PROJECT = {
  KEY: "CCS",
  NAME: "Chat System",
};

const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  throw new Error(
    "Missing required environment variables: JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN are required"
  );
}

interface CreateIssueArgs {
  projectKey: string;
  summary: string;
  issueType: string;
  description?: string;
  assignee?: string;
  labels?: string[];
  components?: string[];
  priority?: string;
  parent?: string;
}

interface BulkIssueInput {
  summary: string;
  issueType: string;
  description?: string;
  projectKey: string;
  assignee?: string;
  labels?: string[];
  components?: string[];
  priority?: string;
  parent?: string;
}

interface CreateIssuesBulkArgs {
  issues: BulkIssueInput[];
}

interface GetIssuesArgs {
  projectKey: string;
  jql?: string;
}

interface UpdateIssueArgs {
  issueKey: string;
  summary?: string;
  description?: string;
  assignee?: string;
  status?: string;
  priority?: string;
}

interface CreateIssueLinkArgs {
  inwardIssueKey: string;
  outwardIssueKey: string;
  linkType: string;
}

interface GetUserArgs {
  email: string;
}

interface IssueType {
  id: string;
  name: string;
  description?: string;
  subtask: boolean;
}

function convertToADF(markdown: string): { version: number; type: string; content: any[] } {
  const lines = markdown.split('\n');
  const content: any[] = [];
  let currentList: any[] | null = null;
  let currentListType: string | null = null;

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) {
      continue;
    }

    // Heading
    if (line.startsWith('#')) {
      content.push({
        type: 'heading',
        attrs: { level: line.match(/^#+/)?.[0].length || 1 },
        content: [{
          type: 'text',
          text: line.replace(/^#+\s+/, ''),
        }],
      });
      continue;
    }

    // List item
    if (line.match(/^[-*]\s/)) {
      if (!currentList) {
        currentList = [];
        currentListType = 'bulletList';
        content.push({
          type: currentListType,
          content: currentList,
        });
      }

      currentList.push({
        type: 'listItem',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'text',
            text: line.replace(/^[-*]\s+/, ''),
          }],
        }],
      });
      continue;
    }

    // Regular paragraph
    currentList = null;
    currentListType = null;
    content.push({
      type: 'paragraph',
      content: [{
        type: 'text',
        text: line,
      }],
    });
  }

  return {
    version: 1,
    type: 'doc',
    content,
  };
}

class JiraServer {
  private readonly server: Server;
  private readonly jira: JiraClient;
  private readonly toolDefinitions = {
    create_issues_bulk: {
      description: "Create multiple Jira issues at once",
      inputSchema: {
        type: "object",
        properties: {
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                projectKey: { type: "string" },
                summary: { type: "string" },
                issueType: { type: "string" },
                description: { type: "string" },
                assignee: { type: "string" },
                labels: {
                  type: "array",
                  items: { type: "string" }
                },
                components: {
                  type: "array",
                  items: { type: "string" }
                },
                priority: { type: "string" },
                parent: { type: "string" }
              },
              required: ["projectKey", "summary", "issueType"]
            }
          }
        },
        required: ["issues"]
      }
    },
    get_issues: {
      description: "Get all issues and subtasks for a Jira project",
      inputSchema: {
        type: "object",
        properties: {
          projectKey: {
            type: "string",
            description: "Project key (e.g., \"PP\")",
          },
          jql: {
            type: "string",
            description: "Optional JQL to filter issues",
          },
        },
        required: ["projectKey"],
      },
    },
    // ... other tool definitions ...
  };

  constructor() {
    this.server = new Server({
      name: "jira",
      version: "0.1.0",
      description: "Jira integration for project management",
      repository: "https://github.com/yourusername/jira-mcp-server",
      tools: this.toolDefinitions,
    });

    this.jira = new JiraClient({
      protocol: "https",
      host: JIRA_HOST,
      username: JIRA_EMAIL,
      password: JIRA_API_TOKEN,
      apiVersion: "3",
      strictSSL: true,
    });

    this.setupRequestHandlers();
  }

  private validateCreateIssuesBulkArgs(args: unknown): args is CreateIssuesBulkArgs {
    if (typeof args !== "object" || args === null) {
      throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object");
    }

    const bulkArgs = args as Partial<CreateIssuesBulkArgs>;
    
    if (!Array.isArray(bulkArgs.issues)) {
      throw new McpError(ErrorCode.InvalidParams, "issues must be an array");
    }

    for (const issue of bulkArgs.issues) {
      if (typeof issue !== "object" || issue === null) {
        throw new McpError(ErrorCode.InvalidParams, "Each issue must be an object");
      }

      const { projectKey, summary, issueType } = issue;

      if (typeof projectKey !== "string" || projectKey.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "Project key is required for each issue");
      }

      if (typeof summary !== "string" || summary.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "Summary is required for each issue");
      }

      if (typeof issueType !== "string" || issueType.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "Issue type is required for each issue");
      }
    }

    return true;
  }

  private setupRequestHandlers(): void {
    this.server.onRequest(ListToolsRequestSchema, async () => ({
      tools: Object.entries(this.toolDefinitions).map(([name, def]) => ({
        name,
        ...def,
      })),
    }));

    this.server.onRequest(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case "create_issues_bulk": {
            if (!request.params.arguments || typeof request.params.arguments !== "object") {
              throw new McpError(ErrorCode.InvalidParams, "Arguments are required");
            }

            const unknownArgs = request.params.arguments as unknown;
            this.validateCreateIssuesBulkArgs(unknownArgs);
            const args = unknownArgs as CreateIssuesBulkArgs;

            const results = await Promise.all(
              args.issues.map(async (issue) => {
                try {
                  const response = await this.jira.addNewIssue({
                    fields: {
                      project: { key: issue.projectKey },
                      summary: issue.summary,
                      issuetype: { name: issue.issueType },
                      description: issue.description ? convertToADF(issue.description) : undefined,
                      ...(issue.assignee ? { assignee: { accountId: issue.assignee } } : {}),
                      labels: issue.labels,
                      components: issue.components?.map((name) => ({ name })),
                      ...(issue.parent ? { parent: { key: issue.parent } } : {})
                    },
                  });

                  return {
                    success: true,
                    key: response.key,
                    id: response.id,
                    url: `https://${JIRA_HOST}/browse/${response.key}`,
                  };
                } catch (error) {
                  return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    summary: issue.summary,
                  };
                }
              })
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ message: "Bulk issue creation completed", results }, null, 2),
                },
              ],
            };
          }

          // ... other case handlers ...
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            { type: "text", text: `Operation failed: ${errorMessage}` },
          ],
          isError: true,
        };
      }
    });
  }

  public async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Jira MCP server running on stdio");
  }
}

const jiraServer = new JiraServer();
jiraServer.run().catch((error: Error) => console.error(error));
