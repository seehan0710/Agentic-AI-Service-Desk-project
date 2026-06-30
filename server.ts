import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Ticket, 
  Comment, 
  KnowledgeBaseArticle, 
  ChatSession, 
  ChatMessage, 
  ReasoningStep, 
  DashboardStats 
} from "./src/types.ts";
import { requireAuth } from "./src/middleware/auth.ts";
import { getOrCreateUser } from "./src/db/users.ts";
import { seedDatabase } from "./src/db/seed.ts";
import {
  getKBArticles,
  createKBArticle,
  upvoteKBArticle,
  getTickets,
  createTicket,
  updateTicket,
  addCommentToTicket,
  getChatSession,
  saveChatSession
} from "./src/db/queries.ts";

dotenv.config();

// ==========================================
// GEMINI RETRY UTILITIES
// ==========================================

function isTransientError(error: any): boolean {
  if (!error) return false;
  const errMsg = String(error.message || error).toLowerCase();
  const errCode = error.status || error.statusCode || error.code || (error.error?.code);
  
  if (errCode === 503 || errCode === 429) {
    return true;
  }
  if (
    errMsg.includes("503") || 
    errMsg.includes("429") || 
    errMsg.includes("unavailable") || 
    errMsg.includes("high demand") || 
    errMsg.includes("rate limit") || 
    errMsg.includes("quota exceeded") ||
    errMsg.includes("temporary")
  ) {
    return true;
  }
  return false;
}

async function callGeminiWithRetry(ai: any, params: any, maxRetries = 3, baseDelay = 1000): Promise<any> {
  const models = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
  let modelIndex = 0;
  let attempt = 0;

  while (true) {
    try {
      // Set the candidate model
      params.model = models[modelIndex];
      return await ai.models.generateContent(params);
    } catch (error: any) {
      attempt++;
      if (isTransientError(error) && attempt <= maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        // Move to the next model in the list to avoid capacity/demand bottlenecks
        modelIndex = (modelIndex + 1) % models.length;
        console.log(`[Gemini Autorecovery] Transient block detected. Retrying with node ${models[modelIndex]} in ${delay.toFixed(0)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

const app = express();
const PORT = Process.env.PORT || 3000;

app.use(express.json());

// ==========================================
// RAG SEARCH ENGINE HEURISTICS
// ==========================================

function searchKB(query: string, articles: KnowledgeBaseArticle[]): { article: KnowledgeBaseArticle; score: number }[] {
  const queryWords = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  if (queryWords.length === 0) return articles.map(a => ({ article: a, score: 0 }));

  return articles.map(article => {
    const text = (article.title + " " + article.content + " " + article.tags.join(" ")).toLowerCase();
    let score = 0;
    
    queryWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'g');
      const matches = text.match(regex);
      if (matches) {
        score += matches.length * 3.0;
      } else if (text.includes(word)) {
        score += 0.8;
      }
      
      if (article.title.toLowerCase().includes(word)) {
        score += 5.0;
      }
      
      if (article.category.toLowerCase().includes(word)) {
        score += 2.0;
      }
    });
    
    return { article, score };
  })
  .filter(item => item.score > 0)
  .sort((a, b) => b.score - a.score);
}

// ==========================================
// SIMULATED AGENT AGENTIC WORKFLOW (FALLBACK)
// ==========================================

function runSimulatedAgent(message: string, retrieved: KnowledgeBaseArticle[]): any {
  const normalized = message.toLowerCase();
  
  let agentResponse = "";
  let status: "diagnosing" | "resolved" | "escalating" = "diagnosing";
  let reasoning = "";
  let diagnosticSteps: string[] = [];
  let ticketMetadata: any = null;

  if (normalized.includes("vpn") || normalized.includes("forticlient") || normalized.includes("gateway")) {
    diagnosticSteps = ["Verify internet connection", "Check FortiClient gateway setting", "Verify LDAP login credentials", "Sync MFA OTP clock"];
    
    if (normalized.includes("timeout") || normalized.includes("locked out") || normalized.includes("reset") || normalized.includes(" authenticator") || normalized.includes("mfa") || normalized.includes("token")) {
      status = "escalating";
      reasoning = "User is experiencing a Multi-Factor Authentication (MFA) lockout or clock sync issue which prevents VPN authentication. Since the user is remote, standard self-service portals are unreachable. Human SecOps team intervention is required to perform identity verification and reset their MFA seed.";
      agentResponse = "I've analyzed your issue regarding the corporate VPN and MFA lockout. Since you are remote and unable to access the internal self-service portal, I cannot automatically reset your MFA token for security reasons. \n\nI have automatically generated a High-Priority ticket for our **SecOps Team** to review and contact you. They will need to perform a brief identity verification before resetting your Google Authenticator token. You should receive an email confirmation shortly.";
      ticketMetadata = {
        title: "VPN Access Refused - MFA Verification Code Failure",
        description: `User reports VPN login failure using FortiClient. They are locked out of their MFA token or seeds. System RAG diagnostics retrieved KB article 'Corporate VPN Connections' and 'Google Authenticator MFA Registration', flagging that remote MFA resets require direct SecOps credential verification.\n\nUser request: "${message}"`,
        category: "Access/MFA",
        priority: "High",
        assignedTeam: "SecOps Team"
      };
    } else {
      reasoning = "User is asking about general VPN connectivity. RAG matched 'Corporate VPN Connections (FortiClient Guide)'. Guiding them to double-check their client version and gateway parameters before considering escalation.";
      agentResponse = "To connect to the corporate VPN, please ensure you have the following configured:\n\n1. **VPN Client**: Make sure you are using **FortiClient v7.2+**.\n2. **Gateway**: The correct address is `vpn.company.com`.\n3. **MFA**: When prompted, open your Google Authenticator app and input your time-based code quickly.\n\nAre you getting a specific error message, like 'Gateway Unreachable' or 'Authentication Failed'? Let me know if you need me to escalate this to our network engineers!";
    }
  } else if (normalized.includes("wifi") || normalized.includes("wireless") || normalized.includes("company-secure")) {
    diagnosticSteps = ["Identify network name", "Verify LDAP identity parameter", "Set EAP configuration to PEAP", "Set phase-2 to MSCHAPv2"];
    
    if (normalized.includes("guest") || normalized.includes("visit")) {
      reasoning = "User asked about Guest Wi-Fi access. Matching KB 'Connecting to Company-Secure Office Wi-Fi' which states guest network does not require LDAP credentials but has restricted intranet access.";
      agentResponse = "For visitors or non-corporate devices, you can connect to **Company-Guest**. This network does not require credentials, but please note it is speed-throttled and completely blocks access to internal resources (such as GitLab, DBs, and Jira). For corporate work, please use **Company-Secure**.";
    } else {
      reasoning = "User reports secure office Wi-Fi connection issues. Match KB article 'Connecting to Company-Secure Office Wi-Fi'. Providing EAP configuration steps.";
      agentResponse = "To connect to the **Company-Secure** Wi-Fi network, please verify your enterprise network adapter parameters are configured as follows:\n\n* **Security Type**: WPA2-Enterprise\n* **EAP Method**: PEAP\n* **Phase 2 Authentication**: MSCHAPv2\n* **Identity**: Use your standard LDAP username (e.g., `jdoe` - do *not* add any domain suffix)\n* **Password**: Your active corporate password\n\nIf you receive a certificate warning, choose **'Do not validate'** or accept our root CA certificate. Let me know if you continue to have trouble!";
    }
  } else if (normalized.includes("password") || normalized.includes("ldap") || normalized.includes("locked out") || normalized.includes("expire")) {
    diagnosticSteps = ["Verify domain lock state", "Direct user to Self-Service Reset", "Warn about security questions requirements", "Identify supervisor check"];
    
    if (normalized.includes("forgot") || normalized.includes("cannot reset") || normalized.includes("help") || normalized.includes("human")) {
      status = "escalating";
      reasoning = "User is locked out of their LDAP account and self-service reset has failed or is inaccessible. Human intervention from SysAdmin Team is required to override password and unlock domain profile, subject to supervisor verification.";
      agentResponse = "I understand you are locked out of your LDAP/corporate password and cannot use the self-service reset. \n\nFor security compliance, helpdesk engineers cannot manually reset passwords without manager authorization. I have logged a Medium-Priority ticket with our **SysAdmin Team** to reset your password and unlock your profile. Your direct manager will be notified to confirm the request.";
      ticketMetadata = {
        title: "LDAP Password Unlock & Domain Reset Failure",
        description: `User is locked out of LDAP domain account and unable to complete self-service recovery. RAG mapped to KB-4 (Self-Service LDAP Resets). Needs manual administrative unlock.\n\nUser request: "${message}"`,
        category: "Access/MFA",
        priority: "Medium",
        assignedTeam: "SysAdmin Team"
      };
    } else {
      reasoning = "User is asking about general password updates. Referring them to the self-service reset portal link.";
      agentResponse = "If your corporate LDAP/domain password has expired or you need a proactive reset, please use our self-service recovery link:\n\n👉 **[https://identity.company.com/reset](https://identity.company.com/reset)**\n\nYou will need to authenticate using your registered SMS phone number or answer your pre-configured security questions. If you are locked out and unable to access this portal, let me know and I will raise a ticket with the identity team.";
    }
  } else if (normalized.includes("print") || normalized.includes("papercut") || normalized.includes("jam") || normalized.includes("toner")) {
    diagnosticSteps = ["Verify PaperCut login", "Install print queue", "Swipe RFID badge", "Check paper/roller condition"];
    
    if (normalized.includes("jam") || normalized.includes("toner") || normalized.includes("broken") || normalized.includes("empty")) {
      status = "escalating";
      reasoning = "Physical hardware printing issue detected (jam/toner/hardware fault). This requires hands-on assistance. Escalating to Facilities/Office Admin queue.";
      agentResponse = "I've diagnosed this as a physical printer hardware issue on Tray 2 or toner depletion. Since this requires physical maintenance, I have generated a service ticket for our **Facilities** team to inspect and service the printer. \n\nThey will dispatch an engineer shortly to clear the jam/replace toner. In the meantime, you can send your jobs to the alternate print queue (e.g., 2nd-floor printer).";
      ticketMetadata = {
        title: "Physical Printer Hardware Fault / Feed Jam Reported",
        description: `User reports printer hardware jam or error. RAG mapped to 'Adding Office Printers via PaperCut Portal'. Escalated to Facilities team for physical inspection.\n\nDetails: "${message}"`,
        category: "Hardware/Printer",
        priority: "Low",
        assignedTeam: "Facilities"
      };
    } else {
      reasoning = "User is asking how to add or setup a network printer. Matching PaperCut portal KB.";
      agentResponse = "Our company printers are managed through **PaperCut**. To add an office printer:\n\n1. Connect to the office network and open: `https://papercut.company.local:9191`.\n2. Log in with your standard LDAP username and password.\n3. Click **'Install Printers'** and follow the automated OS-specific guide.\n4. Once installed, print your document to the NY-3F-Color or SF-2F-B&W queue.\n5. **Important**: Go to the physical printer and **swipe your corporate badge** to release the print job.\n\nLet me know if you run into any driver setup issues!";
    }
  } else if (normalized.includes("slack") || normalized.includes("license") || normalized.includes("adobe") || normalized.includes("jetbrains") || normalized.includes("figma")) {
    diagnosticSteps = ["Verify standard Slack policy", "Direct to Jira Access Portal", "Manager approval prerequisite", "Identify specialized license key"];
    
    if (normalized.includes("request") || normalized.includes("approve") || normalized.includes("need seat")) {
      status = "escalating";
      reasoning = "User is requesting specialized software license allocation. System must log a standard license procurement request in the IT queue for AppSupport and notify their manager for billing approval.";
      agentResponse = "I've recorded your software license seat request. Since specialized tools (Adobe, Figma, JetBrains) carry license fees billed to your department, they require manager authorization. \n\nI have created a ticket in our systems assigned to the **AppSupport Team** and triggered an approval link to your manager. Once they click approve, the license key will be automatically provisioned for you.";
      ticketMetadata = {
        title: "Software License Allocation Request",
        description: `User requests specialized software license seat. Match KB-6 (Software License Requests). Creating ticket for AppSupport and routing manager approval.\n\nRequested items: "${message}"`,
        category: "Software/License",
        priority: "Low",
        assignedTeam: "AppSupport Team"
      };
    } else {
      reasoning = "User is asking general info on Slack or licensing policy. Pointing them to Jira Access Portal.";
      agentResponse = "Standard **Slack Enterprise** profiles are automatically created for all new hires. \n\nIf you need access to specific premium channels or paid software seats (such as Adobe Creative Cloud, JetBrains, or Figma Pro), please submit an application request on the **[Jira Access Portal](https://jira.company.com/access)**. Once approved by your manager, it will be provisioned by the application support engineers.";
    }
  } else {
    diagnosticSteps = ["Identify user core system", "Cross-reference with IT Knowledge base", "Formulate targeted diagnostic inquiry"];
    reasoning = "Unstructured or generic query. Initiating active troubleshooting conversation to narrow down user hardware, access, or network fault.";
    agentResponse = "Hello! I am your AI Support Assistant. I can help you troubleshoot network problems, VPN locks, password locks, printer configurations, and software access.\n\nCould you please provide a few more details about your issue? For example:\n* Are you working remotely or in the office?\n* Are there any specific error messages shown on your screen?\n\nIf we can't solve it here, I can automatically raise a ticket to our network or engineering teams!";
  }

  return {
    agentResponse,
    status,
    reasoning,
    diagnosticSteps,
    ticketMetadata
  };
}

// ==========================================
// API ENDPOINTS
// ==========================================

// Health Check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// GET download README.md
app.get("/api/readme", requireAuth, (req, res) => {
  try {
    const readmePath = path.join(process.cwd(), "README.md");
    res.download(readmePath, "README.md");
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET Knowledge Base Articles
app.get("/api/kb", async (req, res) => {
  try {
    const articles = await getKBArticles();
    res.json(articles);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST New Knowledge Base Article
app.post("/api/kb", requireAuth, async (req, res) => {
  const { title, content, category, tags } = req.body;
  if (!title || !content || !category) {
    return res.status(400).json({ error: "Missing title, content, or category." });
  }

  try {
    const newArticle = await createKBArticle({
      id: `kb-${Date.now()}`,
      title,
      content,
      category,
      tags: tags || [],
    });
    res.json(newArticle);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Incremental help vote
app.post("/api/kb/:id/help", async (req, res) => {
  try {
    const article = await upvoteKBArticle(req.params.id);
    if (article) {
      res.json(article);
    } else {
      res.status(404).json({ error: "Article not found." });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET Tickets (PostgreSQL DB fetch)
app.get("/api/tickets", requireAuth, async (req: any, res) => {
  try {
    const results = await getTickets();
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST Create Ticket Manually
app.post("/api/tickets", requireAuth, async (req: any, res) => {
  const { title, description, category, priority, assignedTeam, userEmail } = req.body;
  if (!title || !description || !category || !priority || !assignedTeam) {
    return res.status(400).json({ error: "Missing required ticket parameters." });
  }

  try {
    const newTicket = await createTicket({
      id: `TICK-${Math.floor(1000 + Math.random() * 9000)}`,
      title,
      description,
      category,
      priority,
      assignedTeam,
      userEmail: userEmail || req.user.email || "lalseehan@gmail.com",
      escalationLog: [
        "Ticket created manually via Portal.",
        `Assigned to specialized team: ${assignedTeam}`
      ]
    });
    res.json(newTicket);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT Update Ticket (status, priority, assignedTeam, etc.)
app.put("/api/tickets/:id", requireAuth, async (req: any, res) => {
  const ticketId = req.params.id;
  try {
    const ticketList = await getTickets();
    const ticket = ticketList.find(t => t.id === ticketId);
    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found." });
    }

    const { status, priority, assignedTeam, commentText, commentAuthor, commentRole } = req.body;

    const updatedLog = [...ticket.escalationLog];
    const updatePayload: any = {};

    if (status && ticket.status !== status) {
      updatedLog.push(`Status updated from '${ticket.status}' to '${status}'`);
      updatePayload.status = status;
    }

    if (priority && ticket.priority !== priority) {
      updatedLog.push(`Priority changed from '${ticket.priority}' to '${priority}'`);
      updatePayload.priority = priority;
    }

    if (assignedTeam && ticket.assignedTeam !== assignedTeam) {
      updatedLog.push(`Assigned team re-allocated from '${ticket.assignedTeam}' to '${assignedTeam}'`);
      updatePayload.assignedTeam = assignedTeam;
    }

    if (commentText) {
      await addCommentToTicket({
        ticketId,
        author: commentAuthor || "IT Engineer",
        role: commentRole || "engineer",
        text: commentText,
      });
      updatedLog.push(`New comment added by ${commentAuthor || "IT Engineer"}`);
    }

    if (Object.keys(updatePayload).length > 0 || commentText) {
      updatePayload.escalationLog = updatedLog;
      await updateTicket(ticketId, updatePayload);
    }

    const updatedTicketList = await getTickets();
    const updatedTicket = updatedTicketList.find(t => t.id === ticketId);
    res.json(updatedTicket);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET or Create Chat Session
app.get("/api/chat/session/:id", requireAuth, async (req, res) => {
  const sessionId = req.params.id;
  try {
    let session = await getChatSession(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        messages: [],
        isEscalated: false,
        status: "diagnosing",
        diagnosticSteps: ["Initiating RAG Context Search", "Analyzing hardware/network telemetry"],
        reasoningLogs: [
          {
            timestamp: new Date().toISOString(),
            phase: "Search Formulation",
            details: "Initialized secure customer support session. Ready for user technical query."
          }
        ]
      };
      await saveChatSession(session);
    }
    res.json(session);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET Stats Dashboard Telemetry
app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const ticketList = await getTickets();
    const total = ticketList.length;
    const open = ticketList.filter(t => t.status === "Open").length;
    const progress = ticketList.filter(t => t.status === "In Progress").length;
    const resolved = ticketList.filter(t => t.status === "Resolved").length;

    const categoryCountsMap: Record<string, number> = {};
    const priorityCountsMap: Record<string, number> = {};

    ticketList.forEach(t => {
      categoryCountsMap[t.category] = (categoryCountsMap[t.category] || 0) + 1;
      priorityCountsMap[t.priority] = (priorityCountsMap[t.priority] || 0) + 1;
    });

    const categoryCounts = Object.keys(categoryCountsMap).map(k => ({
      name: k,
      value: categoryCountsMap[k]
    }));

    const priorityCounts = Object.keys(priorityCountsMap).map(k => ({
      name: k,
      value: priorityCountsMap[k]
    }));

    const ticketTrend = [
      { date: "06/24", open: 2, resolved: 1 },
      { date: "06/25", open: 3, resolved: 1 },
      { date: "06/26", open: 2, resolved: 2 },
      { date: "06/27", open: 4, resolved: 2 },
      { date: "06/28", open: open + progress, resolved: resolved }
    ];

    const stats: DashboardStats = {
      totalTickets: total,
      openTickets: open,
      inProgressTickets: progress,
      resolvedTickets: resolved,
      escalationRate: 35,
      averageResolutionTimeHours: 18.5,
      categoryCounts,
      priorityCounts,
      ticketTrend
    };

    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST Chat Message (Agentic RAG Flow)
app.post("/api/chat", requireAuth, async (req: any, res) => {
  const { sessionId, message, userEmail } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: "Missing sessionId or message." });
  }

  try {
    if (req.user) {
      await getOrCreateUser(req.user.uid, req.user.email || userEmail || "lalseehan@gmail.com");
    }

    let session = await getChatSession(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        messages: [],
        isEscalated: false,
        status: "diagnosing",
        diagnosticSteps: [],
        reasoningLogs: []
      };
    }

    const userMsg: ChatMessage = {
      id: `m-${Date.now()}-user`,
      role: "user",
      text: message,
      createdAt: new Date().toISOString()
    };
    session.messages.push(userMsg);

    const searchLog: ReasoningStep = {
      timestamp: new Date().toISOString(),
      phase: "Search Formulation",
      details: `Parsed query: "${message}". Formulating search token keywords against Knowledge Base.`
    };
    session.reasoningLogs.push(searchLog);

    const kbList = await getKBArticles();
    const searchResults = searchKB(message, kbList);
    const matchedDocs = searchResults.slice(0, 3);
    
    const retrievalLog: ReasoningStep = {
      timestamp: new Date().toISOString(),
      phase: "RAG Retrieval",
      details: matchedDocs.length > 0 
        ? `Retrieved ${matchedDocs.length} matching KB documents:\n` + matchedDocs.map(d => `- "${d.article.title}" (Score: ${d.score.toFixed(1)})`).join("\n")
        : "No matching Knowledge Base articles found. Fallback to generic reasoning."
    };
    session.reasoningLogs.push(retrievalLog);

    const apiKey = process.env.GEMINI_API_KEY;
    const isSimulated = !apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "";

    let agentResult: any;

    const reasoningLog: ReasoningStep = {
      timestamp: new Date().toISOString(),
      phase: "LLM Reasoning",
      details: isSimulated 
        ? `[SIMULATED AGENT] Running in fallback heuristic mode. Matching technical blueprints.`
        : `Invoking 'gemini-3.5-flash' for semantic troubleshooting and escalation check.`
    };
    session.reasoningLogs.push(reasoningLog);

    if (isSimulated) {
      const simulated = runSimulatedAgent(message, matchedDocs.map(d => d.article));
      agentResult = {
        agentResponse: simulated.agentResponse + "\n\n*(Note: Running in Simulated Mode. Setup GEMINI_API_KEY in Secrets to enable live Gemini Agentic RAG routing!)*",
        status: simulated.status,
        reasoning: simulated.reasoning,
        diagnosticSteps: simulated.diagnosticSteps,
        ticketMetadata: simulated.ticketMetadata
      };
    } else {
      try {
        const ai = new GoogleGenAI({
          apiKey: apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            }
          }
        });

        const kbContext = matchedDocs.map(d => `[ARTICLE ID: ${d.article.id}]
Title: ${d.article.title}
Category: ${d.article.category}
Content: ${d.article.content}`).join("\n\n---\n\n");

        const systemInstruction = `You are an expert IT Desk Agent called 'DeskAgent AI'.
You are analyzing a customer support message and determining how to guide them or if you need to escalate to a human technical team.
You have access to the following retrieved Knowledge Base (RAG) context to diagnose the problem:

${kbContext}

CRITICAL OPERATIONAL RULES:
1. Always guide the user step-by-step using ONLY the technical details in the retrieved articles if applicable.
2. If the user's problem is solved by the retrieved guidelines, keep the conversation going and set "status" to "diagnosing" or "resolved".
3. ESCALATION RULE: You must set "status" to "escalating" if and only if:
   - The retrieved articles do NOT contain a solution to the user's issue.
   - The user has already completed the troubleshooting steps in the article but is still blocked (e.g., 'I still get the error', 'I tried PEAP but it failed').
   - It is a severe permission or physical lock (e.g., forgotten LDAP password recovery failed, MFA device lost, printer physical paper jam, hardware broken).
4. If "status" is "escalating", you must populate "ticketMetadata" with appropriate routing:
   - "category": Choose one of "Network/VPN", "Access/MFA", "Hardware/Printer", "Software/License", "Collaboration/Slack", "General".
   - "priority": Choose one of "Low", "Medium", "High", "Critical".
   - "assignedTeam": Map to:
     - Access/MFA, credentials -> "SecOps Team"
     - Network/VPN, connectivity -> "NetOps Team"
     - GitLab/Git/SSH -> "DevOps/Cloud Team"
     - Exchange/Outlook/Password lockout -> "SysAdmin Team"
     - Printer driver, general hardware setup -> "Desktop Support"
     - Physical printer jam, office issues -> "Facilities"
     - Specialized licenses (Figma, JetBrains, Adobe) -> "AppSupport Team"
   - "title": Concise, human ticket title.
   - "description": Complete summary of user request, diagnostic attempts made, and why escalation was required.
5. Provide a thorough "reasoning" detailing your decision-making and logic.

You must respond strictly in JSON.`;

        const formattedHistory = session.messages.map(m => `${m.role === "user" ? "User" : "Agent"}: ${m.text}`).join("\n");

        const response = await callGeminiWithRetry(ai, {
          model: "gemini-3.5-flash",
          contents: `Chat conversation history:\n${formattedHistory}\n\nLast user message: "${message}"\n\nGenerate your agent response, reasoning, diagnostic steps, and ticketing decision:`,
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                agentResponse: { 
                  type: Type.STRING, 
                  description: "The user-facing chat bubble response. Friendly, clear, and troubleshooting-oriented." 
                },
                status: { 
                  type: Type.STRING, 
                  description: "The ticketing status: 'diagnosing' | 'resolved' | 'escalating'." 
                },
                reasoning: { 
                  type: Type.STRING, 
                  description: "The agent's internal thought process, summarizing retrieved articles and user compliance." 
                },
                diagnosticSteps: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "Active checkpoints/diagnostic actions verified or suggested."
                },
                ticketMetadata: {
                  type: Type.OBJECT,
                  description: "Populate only if status is 'escalating'.",
                  properties: {
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    category: { type: Type.STRING },
                    priority: { type: Type.STRING },
                    assignedTeam: { type: Type.STRING }
                  }
                }
              },
              required: ["agentResponse", "status", "reasoning", "diagnosticSteps"]
            }
          }
        });

        const rawText = response.text || "{}";
        agentResult = JSON.parse(rawText.trim());
      } catch (err: any) {
        console.log("[Gemini Status] Call not completed. Activating local failover handler.");
        const simulated = runSimulatedAgent(message, matchedDocs.map(d => d.article));
        agentResult = {
          agentResponse: simulated.agentResponse + `\n\n*(Service Status: Operating under backup logic. Connection details: local routing)*`,
          status: simulated.status,
          reasoning: simulated.reasoning,
          diagnosticSteps: simulated.diagnosticSteps,
          ticketMetadata: simulated.ticketMetadata
        };
      }
    }

    const evalLog: ReasoningStep = {
      timestamp: new Date().toISOString(),
      phase: "Evaluation",
      details: `Agent evaluated conversation state. Status: "${agentResult.status}". Suggested diagnostics: [${agentResult.diagnosticSteps.join(", ")}].`
    };
    session.reasoningLogs.push(evalLog);

    let createdTicket: Ticket | null = null;

    if (agentResult.status === "escalating" && agentResult.ticketMetadata) {
      const ticketId = `TICK-${Math.floor(1000 + Math.random() * 9000)}`;
      const tm = agentResult.ticketMetadata;

      createdTicket = await createTicket({
        id: ticketId,
        title: tm.title || "Support Escalation Ticket",
        description: tm.description || `Automated support ticket for issue: ${message}`,
        category: tm.category || "General",
        priority: tm.priority || "Medium",
        assignedTeam: tm.assignedTeam || "SysAdmin Team",
        userEmail: req.user?.email || userEmail || "lalseehan@gmail.com",
        chatSessionId: sessionId,
        escalationLog: [
          "Ticket created automatically via Agentic RAG Evaluation.",
          `Category mapped: ${tm.category || "General"} | Priority: ${tm.priority || "Medium"}`,
          `Assigned to specialized queue: ${tm.assignedTeam || "SysAdmin Team"}`
        ]
      });

      await addCommentToTicket({
        ticketId,
        author: "DeskAgent AI",
        role: "agent",
        text: `Auto-Escalation Reason: ${agentResult.reasoning}`
      });

      const updatedTickets = await getTickets();
      const dbTicket = updatedTickets.find(t => t.id === ticketId);
      if (dbTicket) {
        createdTicket = dbTicket;
      }

      const dbLog: ReasoningStep = {
        timestamp: new Date().toISOString(),
        phase: "Database Write",
        details: `Triggered auto-escalation hook. Inserted new record ${ticketId} into SQL ticket registry assigned to ${createdTicket.assignedTeam}.`
      };
      session.reasoningLogs.push(dbLog);

      session.isEscalated = true;
      session.escalatedTicketId = ticketId;
      session.status = "escalated";
    } else if (agentResult.status === "resolved") {
      session.status = "resolved";
    } else {
      session.status = "diagnosing";
    }

    if (agentResult.diagnosticSteps && agentResult.diagnosticSteps.length > 0) {
      session.diagnosticSteps = agentResult.diagnosticSteps;
    }

    const modelMsg: ChatMessage = {
      id: `m-${Date.now()}-model`,
      role: "model",
      text: agentResult.agentResponse,
      createdAt: new Date().toISOString()
    };
    session.messages.push(modelMsg);

    await saveChatSession(session);

    res.json({
      chatSession: session,
      escalatedTicket: createdTicket,
      reasoning: agentResult.reasoning
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// VITE DEV SERVER AND PRODUCTION SERVING
// ==========================================

async function startServer() {
  console.log("Checking and seeding database if required...");
  await seedDatabase();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
