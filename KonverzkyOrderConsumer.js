import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

// Create a DynamoDB client and document client.
const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.DDB_TABLE;

export const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  console.log("Received event:", JSON.stringify(event, null, 2));

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    console.error("Error parsing event body:", err);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON in request body" })
    };
  }

  // Validate that the webhook_type is one we expect.
  const allowedWebhookTypes = ["upsell_paid", "product_paid", "order_paid"];
  if (!payload.webhook_type || !allowedWebhookTypes.includes(payload.webhook_type)) {
    console.log("Ignoring event with unsupported webhook_type:", payload.webhook_type);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Ignored unsupported webhook_type" })
    };
  }

  // Validate that order and order.id exist.
  if (!payload.order || !payload.order.id) {
    console.error("Missing order or order.id in payload");
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing order or order.id" })
    };
  }

  const orderId = payload.order.id.toString(); // use as the primary key (string)
  const orderItems = payload.order.items;
  if (!Array.isArray(orderItems)) {
    console.error("order.items is not an array");
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "order.items is not an array" })
    };
  }

  // Map each item to only include the required fields.
  const parsedItems = orderItems.map(item => ({
    name: item.name,
    id: item.id,
    quantity: item.quantity,
    unit_price: item.unit_price,
    vat: item.vat
  }));

  // Retrieve any existing record for this order from DynamoDB.
  let existingOrder;
  try {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { order_id: orderId }
    }));
    existingOrder = result.Item;
  } catch (err) {
    console.error("Error retrieving order from DynamoDB:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error reading from database" })
    };
  }

  // If the order already exists, compare the stored items with the incoming items.
  if (existingOrder) {
    const existingItems = existingOrder.items;
    if (JSON.stringify(existingItems) !== JSON.stringify(parsedItems)) {
      console.warn(`Inconsistency detected for order_id ${orderId}. Existing items: ${JSON.stringify(existingItems)}. New items: ${JSON.stringify(parsedItems)}`);
    } else {
      console.log(`Order ${orderId} already exists with matching items.`);
    }
  }

  // Prepare the record to upsert into DynamoDB.
  const timestamp = new Date().toISOString();
  const record = {
    order_id: orderId,
    items: parsedItems,
    last_updated: timestamp,
    // Keep track of the webhook types that have been received for this order.
    webhook_types: existingOrder && existingOrder.webhook_types
      ? Array.from(new Set([...existingOrder.webhook_types, payload.webhook_type]))
      : [payload.webhook_type]
  };

  // Write or update the record in DynamoDB.
  try {
    await dynamo.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: record
    }));
    console.log(`Order ${orderId} stored/updated successfully.`);
  } catch (err) {
    console.error("Error writing to DynamoDB:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error writing to database" })
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Order processed successfully" })
  };
};
