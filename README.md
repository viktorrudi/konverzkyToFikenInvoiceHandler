# Integrated Invoice Creation Solution

This document describes the design and implementation of an integrated solution that:

## Core Functionalities

- **Processes Konverzky webhooks:**
  - Captures order details (including product information) and stores them in a DynamoDB table.

- **Processes Stripe webhooks:**
  - Receives Stripe "charge.succeeded" events, uses metadata (e.g. order_number) to look up the corresponding order in DynamoDB, fetches additional customer data from Stripe, and then combines this information.

- **Creates and sends invoices in Fiken:**
  - Uses the combined data (order details and customer data) to create an invoice in Fiken and sends a receipt (with the invoice PDF) via email.

- **Implements Retry Mechanism via SQS:**
  - If a Stripe event is received before the corresponding Konverzky order data is available in DynamoDB, the event is sent to an SQS retry queue for later reprocessing.

## 1. Overall Architecture

The solution is composed of three main parts:

### a. Konverzky Webhook Processor

**Purpose:**
- Receives webhooks from Konverzky and stores order details in a DynamoDB table.

**Key Functionality:**
- Extracts essential order data (especially the product details from order.items).
- Uses the order ID (or order_number) as the primary key.
- Upserts order records in DynamoDB.

### b. Stripe Webhook Processor (with SQS-based Retry)

**Purpose:**
- Processes Stripe "charge.succeeded" events that include an order identifier (via charge.metadata.order_number).

**Key Functionality:**
- Validates that the event originates from Konverzky (by checking metadata fields).
- Looks up the corresponding order in DynamoDB.
- If no order is found, queues the event for retry via an SQS queue.
- If found, fetches full customer details from Stripe.
- Uses the order details (stored by the Konverzky processor) to build invoice lines.

### c. Fiken Integration

**Purpose:**
- Uses the combined data to create and send an invoice via Fiken's API.

**Key Functionality:**
- Checks for an existing Fiken contact based on the Stripe customer ID.
- Creates a Fiken contact if one doesn't exist.
- Constructs an invoice payload (with calculated invoice lines, issue date, and due date).
- Creates the invoice in Fiken and sends a receipt email with the invoice PDF attached.

## 2. Detailed Workflow

### Step 1: Receiving Konverzky Webhook Events

**Action:**
- A Lambda function is triggered by a Konverzky webhook.

**Process:**
1. Parses the incoming webhook payload.
2. Extracts order information such as order ID and order items (each containing product name, id, quantity, unit price, and VAT).
3. Inserts or updates a record in a DynamoDB table (e.g., KonverzkyOrders) using the order ID as the key.

### Step 2: Receiving Stripe Webhook Events

**Action:**
- A separate Lambda function (the Stripe processor) is invoked (either directly via API Gateway or indirectly via SQS for retries).

**Process:**
1. Parses the Stripe event and validates it as a "charge.succeeded" event from Konverzky.
2. Extracts the order identifier from charge.metadata.order_number.
3. Looks up the corresponding Konverzky order in DynamoDB.
4. If no order is found:
   - The event (or a minimal payload containing the event and order number) is sent to an SQS retry queue with a configured delay.
5. If the order is found:
   - The function fetches full customer data from Stripe.
   - Verifies essential customer information (email, country, etc.) and determines localization (Norwegian or not).
   - Checks for an existing Fiken contact using the Stripe customer ID; if none exists, it creates one.
   - Combines the stored order items from DynamoDB with customer data to build the invoice lines.

### Step 3: Creating and Sending Invoice in Fiken

**Process:**
1. Calculates invoice issue and due dates (e.g., due date set 30 days from the issue date).
2. Constructs an invoice payload including:
   - Invoice lines based on the stored order items.
   - Bank account details, payment account, currency, and reference information.
3. Sends a POST request to Fiken's API to create the invoice.
4. Extracts the new invoice ID from the response.
5. Constructs and sends a receipt email (with a PDF attachment) using Fiken's invoice send API.

### Step 4: SQS Retry Mechanism

**Action:**
- When the Stripe processor does not find an order in DynamoDB, it packages the event payload into a retry message.

**Process:**
1. The event is sent to an SQS queue (e.g., StripeRetryQueue) with a delay (e.g., 30 seconds).
2. A separate trigger (or the same Lambda configured to process SQS messages) re-invokes the processing logic using the stored event data.
3. This ensures eventual consistency when the Konverzky order data arrives with a slight delay.

## 3. Implementation Details

### a. Code Organization

**Single Codebase for Stripe Processing:**
- The solution leverages one Lambda function file that contains:
  - A common function (`processStripeEvent`) that performs the complete invoice creation and Fiken integration.
  - A main handler that detects whether the invocation is direct (via API Gateway) or via SQS (by checking `event.Records`), and processes each accordingly.

**Reuse:**
- This avoids duplication of Fiken-related logic across multiple files.

### b. Environment Variables and IAM Permissions

**Required Environment Variables:**
- `DDB_TABLE`: DynamoDB table name.
- `STRIPE_RETRY_QUEUE_URL`: URL of the SQS retry queue.
- `FIKEN_BANK_ACCOUNT_CODE`, `FIKEN_PAYMENT_ACCOUNT`, `FIKEN_COMPANY_SLUG`, `FIKEN_API_TOKEN`: For Fiken API calls.
- `STRIPE_API_KEY`: For authenticating with Stripe.

**IAM Permissions:**
- The Lambda function's IAM role must grant:
  - Read and write permissions to DynamoDB for the given table.
  - Permissions to send messages to SQS.
  - Network access to call external APIs (Stripe and Fiken).

### c. Error Handling and Logging
- Every external API call (Stripe and Fiken) is wrapped with error checking.
- DynamoDB operations have try/catch blocks with appropriate logging.
- If a required record isn't found in DynamoDB, the function sends a retry message to SQS and returns a 404.
- Detailed logs are sent to CloudWatch to assist with troubleshooting.