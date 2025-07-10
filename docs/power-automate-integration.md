# Power Automate Webhook Integration Guide

## Overview
This implementation supports the callback URL mechanism for a 4-flow Power Automate architecture with **session-based dual-document processing**:

1. **Document Update Flow** (main flow with HTTP Webhook) → subscribes to → **Approval Webhook** (2nd flow with approver email, callback URL, original document, DAR)
2. **Approval Webhook** flow receives subscription → uploads documents + callback URL to Node.js app → sends generated links to approver via email
3. User signs/declines PDFs in Node.js app (session-based workflow)
4. Node.js app calls **Success Webhook** (3rd flow) OR **Declined Webhook** (4th flow) with data + callback URL
5. **Success/Declined Webhook flows invoke the callback URL** → **Document Update Flow** resumes and processes the response

All document status tracking is done through the database with a session-centric approach. No filesystem-based state tracking is used.

## Webhook Endpoints

### Success Webhook (3rd Flow)
- **Purpose**: Receives signed PDFs + callback URL from Node.js, then invokes callback URL to resume Document Update Flow
- **URL**: Configure in your .env file as `POWER_AUTOMATE_SUCCESS_ENDPOINT`
- **Method**: POST

### Declined Webhook (4th Flow)
- **Purpose**: Receives decline notification + callback URL from Node.js, then invokes callback URL to resume Document Update Flow
- **URL**: Configure in your .env file as `POWER_AUTOMATE_DECLINE_ENDPOINT`
- **Method**: POST

## How It Works

### API Status Codes
When accessing documents via `/api/pdf/:fileId?sessionId=xxx`, the system returns these status codes:

- **200 OK**: PDF is available and not signed/declined
- **400 Bad Request**: Missing required parameters (session ID is always required)
- **410 Gone**: PDF already signed, declined, or expired (with appropriate message)
- **404 Not Found**: Session not found or invalid document

**Critical Requirements**:
- All API calls require a valid `sessionId` parameter
- The system will reject any requests missing a session ID with a 400 Bad Request status
- Links shared with users must always include both the fileId and sessionId parameters
- Frontend displays error modals for all error conditions and disables page interaction

### 1. Document Update Flow Subscribes to Approval Webhook Flow
The Document Update Flow sends subscription to Approval Webhook Flow with:
- Approver email (the number of approvers is determined by your Power Automate logic; the PDF Filler app does not impose a limit)
- Callback URL (from HTTP Webhook action)
- Original document (converted to PDF)
- Document Amendment Record (DAR, converted to PDF)

### 2. Upload Session (Approval Webhook Flow)
The Approval Webhook flow receives the subscription and sends POST request to `/api/pdf/upload-session` with:

```json
{
  "callbackUrl": "https://httpbin.org/post",
  "documents": [
    {
      "type": "original",
      "contentBytes": "base64-encoded-original-pdf-data"
    },
    {
      "type": "dar", 
      "contentBytes": "base64-encoded-dar-pdf-data"
    }
  ]
}
```

**Required**: Exactly 2 documents (original + dar) + callback URL

### 3. Node.js App Response
The app returns document URLs:
```json
{
  "success": true,
  "sessionId": "uuid-session-id",
  "documents": [
    {
      "type": "original",
      "fileId": "uuid-file-id",
      "url": "http://localhost:3000/?fileId=uuid-file-id&sessionId=uuid-session-id"
    },
    {
      "type": "dar",
      "fileId": "uuid-file-id", 
      "url": "http://localhost:3000/?fileId=uuid-file-id&sessionId=uuid-session-id"
    }
  ]
}
```

The Approval Webhook flow then sends these URLs to the approver via email.

### 4. User Signs or Declines PDFs

#### For **Sign** action (All documents signed):
- Node.js app calls **Success Webhook** (3rd flow) with session data + callback URL
- **Success Webhook** flow receives the data, then invokes the callback URL with signed PDFs
- **Document Update Flow** resumes and saves the signed PDFs

#### For **Decline** action (Any document declined):
- Node.js app calls **Declined Webhook** (4th flow) with callback URL
- **Declined Webhook** flow invokes the callback URL with decline response
- **Document Update Flow** resumes and handles the decline

### 5. Webhook Payloads

#### Success Webhook (3rd Flow) receives from Node.js:
```json
{
  "sessionId": "uuid-session-id",
  "status": "completed",
  "documents": [
    {
      "type": "original",
      "fileId": "original-file-id",
      "signedPdfData": "base64-encoded-signed-pdf"
    },
    {
      "type": "dar", 
      "fileId": "dar-file-id",
      "signedPdfData": "base64-encoded-signed-pdf"
    }
  ],
  "completedAt": "2025-07-09T12:00:00.000Z",
  "callbackUrl": "https://httpbin.org/post"
}
```

**Success Webhook flow then invokes callback URL with signed PDFs.**

#### Decline Webhook (4th Flow) receives from Node.js:
```json
{
  "sessionId": "uuid-session-id",
  "status": "declined",
  "declinedAt": "2025-07-09T12:00:00.000Z",
  "callbackUrl": "https://httpbin.org/post"
}
```

**Declined Webhook flow then invokes callback URL with decline response.**

## Testing Integration

For testing purposes, you can use [httpbin.org](https://httpbin.org) as a callback URL endpoint:
```
https://httpbin.org/post
```

This will echo back any data sent to it, allowing you to see exactly what the PDF Filler application is sending to your webhooks during development.

## Error Handling

### Session-Related Errors
- **Session ID Required**: 400 - A valid session ID must be provided with all requests
- **Session Not Found**: 404 - The specified session doesn't exist or has been cleaned up
- **Session Completed**: 404 - The approval session has already been completed
- **Session Expired**: 410 - The session has expired (based on expiration settings)

### Document-Related Errors
- **Invalid Document**: 404 - The document doesn't exist or doesn't belong to the session
- **Already Signed**: 410 - The document has already been signed in this session
- **URL Expired**: 410 - The document URL has expired

The frontend handles all these errors by showing a modal and disabling page interaction. This prevents users from attempting to interact with invalid documents.
