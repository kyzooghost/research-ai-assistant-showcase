import boto3
import os
from openai import OpenAI
import json

def handler(event, context):
    print(f"Received event: {event}")

    # Input validation
    params = validate_request_body(event['body'])
    if params['error'] is not None:
        resp = {
            'statusCode': 400,
            'body': params['error']
        }
        print(resp)
        return resp
    query = params['query']
    filters = params['filters']
    embed_query = params['embed_query']
    email_subject = params['email_subject']
    print(f"query: {query}")
    print(f"filters: {filters}")
    print(f"embed_query: {embed_query}")
    print(f"email_subject: {email_subject}")

    lambda_client = boto3.client('lambda', region_name=os.environ.get('AWS_REGION'))
    openai_client = init_openai_client()
    context_window = None

    # Get query_embedding
    query_embedding = openai_client.embeddings.create(
        input=query, 
        model='text-embedding-ada-002'
    ).data[0].embedding

    print(f'Received query_embedding - {query_embedding}')

    # Get context_window
    context_window_lambda_payload = {
        'query_embedding': query_embedding,
        'filters': filters
    }

    # Despite the context-window Lambda being in our subnet without a public IP, we can use the SDK to invoke it
    # https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/lambda/client/invoke.html
    context_window_response = lambda_client.invoke(
        FunctionName=os.environ.get('CONTEXT_WINDOW_LAMBDA_NAME'),
        InvocationType='RequestResponse',
        LogType='None',
        Payload=json.dumps(context_window_lambda_payload)
    )

    if context_window_response['StatusCode'] != 200:
        resp = {
            'statusCode': context_window_response['StatusCode'],
            'body': context_window_response['FunctionError']
        }
        print(resp)
        return resp
    
    print(f"context_window_response: {context_window_response}")
    context_window = json.load(context_window_response['Payload'])['body']
    print(f"context_window: {context_window}")

    # Send context window + query to LLM

    try:
        llm_response_object = openai_client.chat.completions.create(
            # TODO - Look into optimizing the prompt
            model=os.environ.get('GPT_MODEL'),
            messages=[
                {"role": "system", "content": "You are a helpful investment research assistant. The user will give you a collection of chat messages (delimited with line breaks). Please read through the chat messages carefully and answer the user's question."},
                {"role": "user", "content": f"Chat messages: {context_window}\n---\nQuestion: {query}"},
            ]   
        )
        llm_response = llm_response_object.choices[0].message.content

        resp = {
            'statusCode': 200,
            'body': llm_response
        }
        print(resp)
        return resp
    except Exception as e:
        print(e)
        return {
            'statusCode': 400,
            'body': str(e)
        }

def init_openai_client():
    parameter_store_client = boto3.client('ssm', region_name=os.environ.get('AWS_REGION'))
    secretARN = parameter_store_client.get_parameter(Name='SecretARN')['Parameter']['Value']
    secrets_manager_client = boto3.client('secretsmanager', region_name=os.environ.get('AWS_REGION'))
    secret_stringified = secrets_manager_client.get_secret_value(SecretId=secretARN)['SecretString']
    secret = json.loads(secret_stringified)
    user = os.environ.get('USER')
    openai_client = OpenAI(api_key=secret[f"OPENAI_API_KEY{user}"])
    return openai_client

# Allow function invocation as curl POST request and direct AWS Lambda SDK invocation
def validate_request_body(request_body):
    if (type(request_body) == str):
        return validate_request_body_dict(json.loads(request_body))
    elif (type(request_body) == dict):
        return validate_request_body_dict(request_body)
    else:
        return {"error": "Could not parse event body"}

def validate_request_body_dict(request_body_dict):
    if request_body_dict.get('query') is None:
        return {"error": "Missing query"}
    if request_body_dict.get('filters') is None:
        return {"error": "Missing filters"}
    
    embed_query = None
    if request_body_dict.get('embed_query') is not None:
        embed_query_param = request_body_dict.get('embed_query')
        embed_query = False if embed_query_param == 'false' or embed_query_param == 'False' else None

    email_subject = None
    if request_body_dict.get('email_subject') is not None:
        email_subject = request_body_dict.get('email_subject')

    return {
        "query": request_body_dict["query"],
        "filters": request_body_dict["filters"],
        "embed_query": embed_query,
        "email_subject": email_subject,
        "error": None
    }