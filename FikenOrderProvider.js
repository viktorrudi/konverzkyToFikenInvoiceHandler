import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

// Initialize clients.
const ddbClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(ddbClient);
const sqsClient = new SQSClient({});
const snsClient = new SNSClient({});

// Environment variables.
const TABLE_NAME = process.env.DDB_TABLE;
const RETRY_QUEUE_URL = process.env.STRIPE_RETRY_QUEUE_URL;
const SNS_TOPIC_ARN = process.env.MANUAL_ORDER_SNS_TOPIC;
const bankAccountCode = process.env.FIKEN_BANK_ACCOUNT_CODE;
const paymentAccount = process.env.FIKEN_PAYMENT_ACCOUNT;
const companySlug = process.env.FIKEN_COMPANY_SLUG;
const fikenToken = process.env.FIKEN_API_TOKEN;
const stripeApiKey = process.env.STRIPE_API_KEY;

// Helper function to send a message to SQS for retry.
async function sendRetryMessage(messageBody) {
  try {
    const params = {
      QueueUrl: RETRY_QUEUE_URL,
      MessageBody: JSON.stringify(messageBody),
      DelaySeconds: 5 // Delay processing by 30 seconds.
    };
    const command = new SendMessageCommand(params);
    const response = await sqsClient.send(command);
    console.log("Message sent to SQS with ID:", response.MessageId);
  } catch (error) {
    console.error("Error sending message to SQS:", error);
    throw error;
  }
}

// Helper function to send SNS notification for manual order handling
async function sendManualOrderNotification(charge) {
  try {
    const params = {
      TopicArn: SNS_TOPIC_ARN,
      Subject: `Manual order handling required for charge ${charge.id}`,
      Message: JSON.stringify({
        message: "A charge requires manual order handling due to missing metadata",
        charge: charge,
        timestamp: new Date().toISOString()
      }, null, 2)
    };
    const command = new PublishCommand(params);
    const response = await snsClient.send(command);
    console.log("SNS notification sent with ID:", response.MessageId);
    return response;
  } catch (error) {
    console.error("Error sending SNS notification:", error);
    throw error;
  }
}

// The common function that processes a Stripe event.
async function processStripeEvent(stripeEvent, lambdaInput) {
  // Validate required environment variables.
  if (!bankAccountCode) throw new Error("FIKEN_BANK_ACCOUNT_CODE environment variable is not set");
  if (!paymentAccount) throw new Error("FIKEN_PAYMENT_ACCOUNT environment variable is not set");
  if (!companySlug) throw new Error("FIKEN_COMPANY_SLUG environment variable is not set");
  if (!fikenToken) throw new Error("FIKEN_API_TOKEN environment variable is not set");
  if (!stripeApiKey) throw new Error("STRIPE_API_KEY environment variable is not set");
  if (!TABLE_NAME) throw new Error("DDB_TABLE environment variable is not set");
  if (!RETRY_QUEUE_URL) throw new Error("STRIPE_RETRY_QUEUE_URL environment variable is not set");
  if (!SNS_TOPIC_ARN) throw new Error("MANUAL_ORDER_SNS_TOPIC environment variable is not set");

  console.log("[PROCESS] Processing Stripe event:", JSON.stringify({stripeEvent, lambdaInput}, null, 2));

  // Validate the event: we expect a charge.succeeded event from Stripe.
  const charge = stripeEvent.data.object;
  if (!charge) throw new Error("Charge object missing in Stripe event");
  const currency = charge.currency ? charge.currency.toUpperCase() : null;
  if (!currency) {
    throw new Error(`Missing amount or currency on Charge ${charge.id}.`);
  }

  if (stripeEvent.type !== "charge.succeeded") {
    console.log(`Ignoring event (cause: ${stripeEvent.type}):`, JSON.stringify(stripeEvent));
    return { statusCode: 200, body: JSON.stringify({ message: stripeEvent.type }) };
  }

  if (!charge.metadata || !charge.metadata.order_number) {
    console.log(`Missing metadata or order_number in charge ${charge.id}, sending SNS notification for manual handling`);
    await sendManualOrderNotification(charge);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Manual order handling notification sent" })
    };
  }

  const customerId = charge.customer;
  if (!customerId) {
    throw new Error(`No customer ID found on Charge ${charge.id}.`);
  }

  console.log(`Processing order #${charge.metadata.order_number}`);
  // Look up the Konverzky order in DynamoDB using the order_number.
  const konverzkyOrderId = charge.metadata.order_number.toString();
  let orderRecord;
  try {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { order_id: konverzkyOrderId }
    }));
    orderRecord = result.Item;
  } catch (err) {
    console.error("Error retrieving order from DynamoDB:", err);
    throw new Error("Error reading from database");
  }
  if (!orderRecord) {
    console.error(`No order information found in DB for order id ${konverzkyOrderId}`);
    // If no order is found, queue a retry.
    const retryPayload = {
      order_number: konverzkyOrderId,
      stripeEvent: stripeEvent,
      timestamp: new Date().toISOString()
    };
    await sendRetryMessage(retryPayload);
    return { statusCode: 200, body: JSON.stringify({ error: "Order not found, event queued for retry" }) };
  }
  console.log("Found order in DB:", JSON.stringify(orderRecord));

  // Fetch full customer data from Stripe.
  console.log(`Going to look up Stripe Customer with id ${customerId}`);
  const stripeCustomerResponse = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${stripeApiKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
  if (!stripeCustomerResponse.ok) {
    const errorText = await stripeCustomerResponse.text();
    throw new Error(`Stripe API error (fetch customer): ${stripeCustomerResponse.status} - ${errorText}`);
  }
  const stripeCustomer = await stripeCustomerResponse.json();
  console.log("Fetched Stripe customer:", stripeCustomer);

  // Extract customer details.
  const customerEmail = stripeCustomer.email || charge.receipt_email;
  const customerName = stripeCustomer.name || customerEmail;
  const customerAddress = stripeCustomer.address || {};
  const customerCountry = customerAddress.country || customerAddress.state;
  if (!customerEmail) throw new Error(`No customer email found for Charge ${charge.id}.`);
  if (!customerCountry) throw new Error(`No customer country found for Charge ${charge.id}.`);
  const isNorwegian = ['NO', 'NORWAY', 'NORGE', 'NOREG', 'NOR'].includes(customerCountry.toUpperCase());

  // Check for an existing Fiken contact.
  const fikenContactsUrl = `https://api.fiken.no/api/v2/companies/${companySlug}/contacts?memberNumberString=${customerId}`;
  console.log("Checking for existing Fiken contact at:", fikenContactsUrl);
  const getContactsResponse = await fetch(fikenContactsUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${fikenToken}`
    }
  });
  if (!getContactsResponse.ok) {
    const errorText = await getContactsResponse.text();
    throw new Error(`Fiken API error (get contacts): ${getContactsResponse.status} - ${errorText}`);
  }
  const contacts = await getContactsResponse.json();
  let newContactId;
  if (contacts && contacts.length > 0) {
    newContactId = contacts[0].id || contacts[0].contactId;
    console.log(`Found existing Fiken contact with ID: ${newContactId}`);
  } else {
    // Create a new Fiken contact.
    const contactPayload = {
      customer: true,
      name: customerName,
      email: customerEmail,
      memberNumberString: customerId,
      language: isNorwegian ? "Norwegian" : "English",
      address: {
        streetAddress: customerAddress.line1,
        streetAddressLine2: customerAddress.line2,
        city: customerAddress.city,
        postCode: customerAddress.postal_code,
        country: customerCountry
      }
    };
    const fikenContactCreateUrl = `https://api.fiken.no/api/v2/companies/${companySlug}/contacts`;
    console.log("Creating new contact in Fiken with payload:", contactPayload);
    const createContactResponse = await fetch(fikenContactCreateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${fikenToken}`
      },
      body: JSON.stringify(contactPayload)
    });
    const createContactText = await createContactResponse.text();
    if (!createContactResponse.ok) {
      throw new Error(`Fiken API error (create contact): ${createContactResponse.status} - ${createContactText}`);
    }
    const locationHeader = createContactResponse.headers.get("Location");
    if (!locationHeader) throw new Error("Fiken API did not return Location header for created contact");
    newContactId = locationHeader.split('/').pop();
    console.log("New contact created with ID:", newContactId);
  }

  // Build invoice lines using order items from DynamoDB.
  const commonProductProperties = {
    currency,
    vatType: isNorwegian ? 'HIGH' : 'EXEMPT_IMPORT_EXPORT',
    incomeAccount: isNorwegian ? 3010 : 3110
  };
  const lines = orderRecord.items.map(item => ({
    ...commonProductProperties,
    productName: item.name,
    description: item.name,
    comment: `#${item.id}`,
    unitPrice: item.unit_price * 100, // Fiken needs value without separator (e.g. EUR 19.99 must be  EUR 1999)
    quantity: item.quantity
  }));

  // Calculate invoice issue and due dates (30 days from today).
  const todayDate = new Date();
  const issueDate = todayDate.toISOString().split("T")[0];
  const dueDate = new Date(todayDate.getTime() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  // Build Fiken invoice payload.
  const invoicePayload = {
    issueDate,
    dueDate,
    lines,
    bankAccountCode,
    paymentAccount,
    cash: true,
    customerId: newContactId,
    currency: currency.toUpperCase(),
    invoiceText: isNorwegian
      ? "Faktura for produkter kjøpt via Pattern Magicians."
      : "Invoice for products purchased via Pattern Magicians.",
    yourReference: konverzkyOrderId
  };

  console.log("Creating invoice in Fiken with payload:", JSON.stringify(invoicePayload));
  const fikenInvoiceUrl = `https://api.fiken.no/api/v2/companies/${companySlug}/invoices`;
  const createInvoiceResponse = await fetch(fikenInvoiceUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${fikenToken}`
    },
    body: JSON.stringify(invoicePayload)
  });
  console.log("Create Invoice status:", createInvoiceResponse.status);
  if (!createInvoiceResponse.ok) {
    const createInvoiceText = await createInvoiceResponse.text();
    throw new Error(`Fiken API error (create invoice): ${createInvoiceResponse.status} - ${createInvoiceText}`);
  }
  const invoiceLocationHeader = createInvoiceResponse.headers.get("Location");
  if (!invoiceLocationHeader) {
    throw new Error("Fiken API did not return Location header for created invoice");
  }
  const newInvoiceId = invoiceLocationHeader.split('/').pop();
  console.log("Invoice created with ID:", newInvoiceId);

  // Prepare email message for receipt.
  const messageText = isNorwegian
    ? `Hei ${customerName},\n\nDU HAR ALLEREDE BETALT, IKKE PRØV Å BETAL IGJEN\n\nVi har mottatt din betaling.\n\nHer er din kvittering (PDF).\n\nTakk for din støtte!`
    : `Dear ${customerName},\n\nYOU HAVE PAID, PLEASE DO NOT TRY TO PAY AGAIN\n\nPlease find attached your receipt (PDF) for your recent purchase.\n\nThank you for your support!`;

  // Send receipt via email using Fiken.
  const fikenSendInvoiceUrl = `https://api.fiken.no/api/v2/companies/${companySlug}/invoices/send`;
  const sendInvoicePayload = {
    invoiceId: newInvoiceId,
    recipientEmail: customerEmail,
    recipientName: customerName,
    message: messageText,
    method: ['email'],
    subject: "Your receipt from Pattern Magicians",
    emailSendOption: "attachment"
  };
  console.log("Sending receipt via email with payload:", sendInvoicePayload);
  const sendInvoiceResponse = await fetch(fikenSendInvoiceUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${fikenToken}`
    },
    body: JSON.stringify(sendInvoicePayload)
  });
  console.log("Send Invoice status:", sendInvoiceResponse.status);
  if (!sendInvoiceResponse.ok) {
    const sendInvoiceText = await sendInvoiceResponse.text();
    throw new Error(`Fiken API error (send invoice): ${sendInvoiceResponse.status} - ${sendInvoiceText}`);
  }
  console.log("Invoice sent via email successfully.");

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Contact and invoice created and sent via email successfully"
    })
  };
}

// Main handler that supports both SQS events and direct invocation.
export const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    // If event.Records exists, assume an SQS event.
    if (event.Records && Array.isArray(event.Records)) {
      const results = await Promise.all(event.Records.map(async (record) => {
        // The SQS message body should be a JSON string containing { order_number, stripeEvent, timestamp }.
        const payload = JSON.parse(record.body);
        console.log("Processing SQS record:", payload);
        return await processStripeEvent(payload.stripeEvent, { event, context });
      }));
      console.log("All SQS records processed:", results);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "All SQS records processed successfully", results })
      };
    } else {
      // Otherwise, assume a direct invocation with event.body as a Stripe event.
      const stripeEvent = JSON.parse(event.body);
      return await processStripeEvent(stripeEvent, { event, context });
    }
  } catch (error) {
    console.error("[ERROR] processing event:", { error, requestId: context.awsRequestId });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
