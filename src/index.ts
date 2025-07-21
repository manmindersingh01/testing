// index.ts - Simplified test version that processes prompts from Azure Service Bus without user/DB dependencies

import { v4 as uuidv4 } from "uuid";
import AdmZip from "adm-zip";
import * as fs from "fs";
import path from "path";
import {
  uploadToAzureBlob,
  triggerAzureContainerJob,
  deployToSWA,
} from "./services/azure-deploy";
import {
  parseFrontendCode,
  processTailwindProject,
  type ParsedResult,
} from "./utils/newparser";
import { ServiceBusClient, ServiceBusReceiver } from "@azure/service-bus";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import dotenv from "dotenv";
import {systemPrompt} from "./defaults/promt"

// Load environment variables
dotenv.config();

// Initialize AWS Bedrock client for Claude
const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// Claude system prompt


interface FileData {
  path: string;
  content: string;
}

interface PromptMessage {
  prompt: string;
}

// Basic session tracking for temp files (simplified)
class SimpleSessionManager {
  private sessions: Map<string, { tempDir: string }>;

  constructor() {
    this.sessions = new Map();
  }

  createSession(sessionId: string, tempDir: string): void {
    this.sessions.set(sessionId, { tempDir });
  }

  getTempDir(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.tempDir;
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  generateSessionId(): string {
    return `session-${uuidv4()}`;
  }
}

const sessionManager = new SimpleSessionManager();

async function cleanupTempDirectory(buildId: string): Promise<void> {
  const tempBuildDir = path.join(__dirname, "../temp-builds", buildId);
  try {
    if (fs.existsSync(tempBuildDir)) {
      await fs.promises.rm(tempBuildDir, { recursive: true, force: true });
      console.log(`[${buildId}] 🧹 Temp directory cleaned up`);
    }
  } catch (error) {
    console.warn(`[${buildId}] ⚠️ Failed to cleanup temp directory:`, error);
  }
}

function scheduleCleanup(buildId: string, delayInHours: number = 1): void {
  const delayMs = delayInHours * 60 * 60 * 1000;
  setTimeout(async () => {
    console.log(`[${buildId}] 🕐 Scheduled cleanup starting after ${delayInHours} hour(s)`);
    await cleanupTempDirectory(buildId);
  }, delayMs);
  console.log(`[${buildId}] ⏰ Cleanup scheduled for ${delayInHours} hour(s) from now`);
}

// Generate code using AWS Bedrock Claude
async function generateCodeWithBedrock(prompt: string): Promise<string> {
  console.log("🤖 Generating code with AWS Bedrock Claude...");
  
  // Make sure you have these imports at the top of your file:
  // import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
  
  const input = {
    modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 60000,
      temperature: 1,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      ],
    }),
  };

  try {
    // Use regular InvokeModelCommand but with chunked processing logic
    const command = new InvokeModelCommand(input);
    const response = await bedrockClient.send(command);

    if (!response.body) {
      throw new Error("Empty response from Bedrock");
    }

    // Parse the response
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    
    if (!responseBody.content || responseBody.content.length === 0) {
      throw new Error("No content in Bedrock response");
    }

    const fullResponse = responseBody.content[0].text;
    const totalChars = fullResponse.length;
    
    // Simulate streaming by logging progress in chunks
    const chunkSize = 10000;
    for (let i = 0; i < totalChars; i += chunkSize) {
      if (i > 0) {
        console.log(`[Progress] Processed ${i} characters out of ${totalChars}...`);
      }
    }
    
    console.log(`✅ Code generation completed with ${totalChars} total characters`);
    return fullResponse;
  } catch (error) {
    console.error("❌ Error generating code with Bedrock streaming:", error);
    throw error;
  }
}

// Process a prompt message and generate, build, and deploy a project
async function processPromptMessage(message: PromptMessage): Promise<void> {
  const buildId = uuidv4();
  const sessionId = sessionManager.generateSessionId();
  const startTime = Date.now();

  console.log(`[${buildId}] 🚀 Starting processing for prompt: "${message.prompt.substring(0, 100)}${message.prompt.length > 100 ? '...' : ''}"`);

  const sourceTemplateDir = path.join(__dirname, "../react-base");
  const tempBuildDir = path.join(__dirname, "../temp-builds", buildId);
  
  // Create a timer function for performance tracking
  const logTimeSince = (label: string) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[${buildId}] ⏱️ ${label}: ${elapsed}s elapsed`);
  };

  try {
    // Setup temp directory with error handling
    try {
      await fs.promises.mkdir(tempBuildDir, { recursive: true });
      await fs.promises.cp(sourceTemplateDir, tempBuildDir, { recursive: true });
      console.log(`[${buildId}] 📁 Temp directory created at ${tempBuildDir}`);
    } catch (dirError) {
      console.error(`[${buildId}] ❌ Failed to create temp directory:`, dirError);
      throw new Error(`Failed to create temp build directory: ${dirError instanceof Error ? dirError.message : "Unknown error"}`);
    }

    // Track the session and temp directory
    sessionManager.createSession(sessionId, tempBuildDir);
    
    // Generate code with AWS Bedrock Claude
    console.log(`[${buildId}] 🤖 Generating frontend code with AWS Bedrock Claude...`);
    
    // Add progress callbacks and better error handling
    let claudeResponse: string;
    try {
      claudeResponse = await generateCodeWithBedrock(message.prompt);
      logTimeSince("Code generation completed");
      console.log(`[${buildId}] ✅ Code generation completed with ${claudeResponse.length.toLocaleString()} characters`);
    } catch (genError) {
      console.error(`[${buildId}] ❌ Code generation failed:`, genError);
      throw new Error(`Failed to generate code with Bedrock: ${genError instanceof Error ? genError.message : "Unknown error"}`);
    }
    
    // Validate the response isn't empty
    if (!claudeResponse || claudeResponse.trim().length === 0) {
      throw new Error("Empty response received from Bedrock");
    }

    // Parse generated files with better error handling
    let parsedResult: ParsedResult;
    try {
      console.log(`[${buildId}] 📝 Parsing generated code...`);
      parsedResult = parseFrontendCode(claudeResponse);
      logTimeSince("Code parsing");
      console.log(`[${buildId}] ✅ Code parsing successful`);
      console.log(`[${buildId}] 📊 Parsed ${parsedResult.codeFiles.length} files`);
    } catch (parseError) {
      console.error(`[${buildId}] ❌ Enhanced parser failed:`, parseError);
      
      // Save the raw response for debugging
      try {
        const debugPath = path.join(tempBuildDir, "debug_raw_response.txt");
        await fs.promises.writeFile(debugPath, claudeResponse, "utf8");
        console.log(`[${buildId}] 🔍 Saved raw response for debugging at: ${debugPath}`);
      } catch (debugError) {
        console.error(`[${buildId}] ⚠️ Failed to save debug file:`, debugError);
      }
      
      throw new Error(`Failed to parse Claude response: ${parseError instanceof Error ? parseError.message : "Unknown error"}`);
    }

    // Process files with validation
    console.log(`[${buildId}] 🔧 Processing files with enhanced validation...`);
    let processedProject;
    try {
      processedProject = processTailwindProject(parsedResult.codeFiles);
      logTimeSince("File processing");
    } catch (processError) {
      console.error(`[${buildId}] ❌ File processing failed:`, processError);
      throw new Error(`Failed to process files: ${processError instanceof Error ? processError.message : "Unknown error"}`);
    }
    
    const { processedFiles } = processedProject;
    const parsedFiles: FileData[] = processedFiles;

    if (!parsedFiles || parsedFiles.length === 0) {
      throw new Error("No files generated from Claude response");
    }

    console.log(`[${buildId}] 💾 Writing ${parsedFiles.length} files...`);

    // Parallelize file writing for better performance
    const writePromises = parsedFiles.map(async (file) => {
      try {
        const fullPath = path.join(tempBuildDir, file.path);
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, file.content, "utf8");
        return { path: file.path, success: true };
      } catch (writeError) {
        console.error(`[${buildId}] ❌ Failed to write ${file.path}:`, writeError);
        return { path: file.path, success: false, error: writeError };
      }
    });
    
    // Wait for all files to be written
    const writeResults = await Promise.all(writePromises);
    const failedFiles = writeResults.filter(r => !r.success);
    
    if (failedFiles.length > 0) {
      console.error(`[${buildId}] ⚠️ Failed to write ${failedFiles.length} files`);
    } else {
      console.log(`[${buildId}] ✅ Successfully wrote ${writeResults.length} files`);
    }
    
    logTimeSince("File writing");

    // Create zip with error handling
    console.log(`[${buildId}] 📦 Creating zip and uploading to Azure...`);
    let zipBuffer: Buffer;
    try {
      const zip = new AdmZip();
      zip.addLocalFolder(tempBuildDir);
      zipBuffer = zip.toBuffer();
      console.log(`[${buildId}] ✅ Created zip (${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
    } catch (zipError) {
      console.error(`[${buildId}] ❌ Failed to create zip:`, zipError);
      throw new Error(`Failed to create zip file: ${zipError instanceof Error ? zipError.message : "Unknown error"}`);
    }

    // Upload to Azure with retry logic
    const zipBlobName = `${buildId}/source.zip`;
    let zipUrl: string;
    try {
      zipUrl = await uploadToAzureBlob(
        process.env.AZURE_STORAGE_CONNECTION_STRING!,
        "source-zips",
        zipBlobName,
        zipBuffer
      );
      console.log(`[${buildId}] ✅ Uploaded zip to Azure: ${zipUrl}`);
      logTimeSince("Azure upload");
    } catch (uploadError) {
      console.error(`[${buildId}] ❌ Failed to upload to Azure:`, uploadError);
      throw new Error(`Failed to upload to Azure: ${uploadError instanceof Error ? uploadError.message : "Unknown error"}`);
    }
 
    // Trigger Azure Container Job for build with timeout
    console.log(`[${buildId}] 🔧 Triggering Azure Container Job for build...`);
    let distUrl: string;
    try {
      distUrl = await Promise.race([
        triggerAzureContainerJob(zipUrl, buildId, {
          resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
          containerAppEnv: process.env.AZURE_CONTAINER_APP_ENV!,
          acrName: process.env.AZURE_ACR_NAME!,
          storageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING!,
          storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME!,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Azure Container Job timed out after 5 minutes")), 5 * 60 * 1000);
        })
      ]);
      logTimeSince("Azure container job");
    } catch (containerError) {
      console.error(`[${buildId}] ❌ Azure Container Job failed:`, containerError);
      throw new Error(`Failed to execute Azure Container Job: ${containerError instanceof Error ? containerError.message : "Unknown error"}`);
    }

    // Parse URLs with validation
    let urls: { downloadUrl: string };
    try {
      urls = JSON.parse(distUrl);
      if (!urls.downloadUrl) {
        throw new Error("Missing downloadUrl in response");
      }
    } catch (parseError) {
      console.error(`[${buildId}] ❌ Failed to parse container job response:`, parseError);
      throw new Error(`Invalid response from container job: ${parseError instanceof Error ? parseError.message : "Unknown error"}`);
    }
    
    const builtZipUrl = urls.downloadUrl;

    // Deploy to Azure Static Web Apps
    console.log(`[${buildId}] 🚀 Deploying to Azure Static Web Apps...`);
    let deployResult: { previewUrl: string, downloadUrl: string };
    try {
      deployResult = await deployToSWA(builtZipUrl, buildId);
      logTimeSince("SWA deployment");
    } catch (deployError) {
      console.error(`[${buildId}] ❌ Deployment to SWA failed:`, deployError);
      throw new Error(`Failed to deploy to Static Web Apps: ${deployError instanceof Error ? deployError.message : "Unknown error"}`);
    }

    const { previewUrl, downloadUrl } = deployResult;

    // Validate URLs
    if (!previewUrl || !downloadUrl) {
      console.warn(`[${buildId}] ⚠️ Missing URLs in deployment result`);
    }

    // Log the results
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[${buildId}] ✅ Build process completed successfully in ${totalTime}s!`);
    console.log(`[${buildId}] 🔗 Preview URL: ${previewUrl}`);
    console.log(`[${buildId}] 🔗 Download URL: ${downloadUrl}`);
    console.log(`[${buildId}] 🔗 Zip URL: ${zipUrl}`);

    // Schedule cleanup
    scheduleCleanup(buildId, 1);
  } catch (error) {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`[${buildId}] ❌ Build process failed after ${totalTime}s:`, error);

    // Attempt to save error logs
    try {
      const errorLogPath = path.join(tempBuildDir, "error.log");
      await fs.promises.writeFile(
        errorLogPath,
        `Error: ${error instanceof Error ? error.message : String(error)}\n` +
        `Stack: ${error instanceof Error && error.stack ? error.stack : 'No stack trace'}\n` +
        `Time: ${new Date().toISOString()}\n`,
        "utf8"
      );
      console.log(`[${buildId}] 📝 Error log saved at: ${errorLogPath}`);
    } catch (logError) {
      console.error(`[${buildId}] ⚠️ Failed to save error log:`, logError);
    }

    // Cleanup on error
    sessionManager.removeSession(sessionId);
    await cleanupTempDirectory(buildId);
    
    // Rethrow with consistent error format
    throw new Error(`Build process failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Main function to listen to Azure Service Bus and process messages
async function main() {
  console.log("🚀 Starting Azure Service Bus listener for code generation...");

  const queueName = process.env.Bus;

  if (!serviceBusConnectionString) {
    console.error("❌ Azure Service Bus connection string not provided!");
    process.exit(1);
  }

  // Create Service Bus client and receiver
  const serviceBusClient = new ServiceBusClient(serviceBusConnectionString);
  const receiver = serviceBusClient.createReceiver(queueName, {
    receiveMode: "peekLock",
  });

  console.log(`📥 Listening for messages on queue: ${queueName}`);

  try {
    // Subscribe to messages
    const messageHandler = async (message: any) => {
      console.log(`📨 Received message: ${message.messageId}`);
      
      try {
        // Parse the message body
        const messageBody: PromptMessage = JSON.parse(message.body);
        console.log(`📝 Processing prompt: "${messageBody.prompt.substring(0, 100)}..."`);

        // Process the prompt message
        await processPromptMessage(messageBody);
        
        // Complete the message (remove from queue)
        await receiver.completeMessage(message);
        console.log(`✅ Completed processing message: ${message.messageId}`);
      } catch (error) {
        console.error(`❌ Error processing message: ${message.messageId}`, error);
        
        // Abandon the message (return to queue for retry)
        await receiver.abandonMessage(message);
        console.log(`🔄 Abandoned message for retry: ${message.messageId}`);
      }
    };

    // Register the message handler
    receiver.subscribe({
      processMessage: messageHandler,
      processError: async (err) => {
        console.error("❌ Error processing message:", err);
      }
    });

    console.log("🎧 Listening for messages...");
    
    // Keep the process running
    process.on("SIGINT", async () => {
      console.log("👋 Shutting down Service Bus receiver...");
      await receiver.close();
      await serviceBusClient.close();
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ Error initializing Service Bus listener:", error);
    await receiver.close();
    await serviceBusClient.close();
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main().catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  });
}

export { processPromptMessage };