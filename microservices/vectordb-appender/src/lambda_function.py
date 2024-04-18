# Embedding CSV on S3 -> ChromaDB storage on EFS
__import__('pysqlite3')
import sys
sys.modules['sqlite3'] = sys.modules.pop('pysqlite3')

import boto3
import pandas as pd
import chromadb
import os
import subprocess
import json

def handler(event, context):
    print(f"Received event: {event}")

    # Input validation
    if 'Records' not in event:
        resp = {
            'statusCode': 400,
            'body': 'Not invoked via SQS event source, missing "Records" key'
        }
        print(resp)
        return resp

    params = validate_invocation_message(event['Records'])
    if params['error'] is not None:
        resp = {
            'statusCode': 400,
            'body': params['error']
        }
        print(resp)
        return resp
    bucket_name = params['bucket_name']
    object_key = params['object_key']
    print(f"bucket_name: {bucket_name}")
    print(f"object_key: {object_key}")

    s3_client = boto3.client('s3', region_name='us-west-2')
    csv_file_name = object_key.split('/')[-1]
    chroma_client = chromadb.PersistentClient(os.environ.get("ChromaDBLambdaMountDirectory"))

    # Clean /tmp - if we have concurrent invocations of this lambda function, we may have persisted data in /tmp from previous invocation
    scrape_job = subprocess.check_output('rm -rf /tmp/*', shell=True)

    s3_client.download_file(
        Bucket=bucket_name,
        Key=object_key,
        Filename=f'/tmp/{csv_file_name}'
    )

    print(f"Downloaded {object_key} from S3")
    df = pd.read_csv(f'/tmp/{csv_file_name}')

    collection = chroma_client.get_or_create_collection(
        name=os.environ.get("ChromaDBCollectionName"),
        metadata={"hnsw:space": "cosine"}
    )

    metadata_list = [
        'date',
        'n_tokens',
        'user_id',
        'chat_id',
        'medium'
    ]

    collection.upsert(
        documents=df.text.tolist(),
        # TODO - How else to convert from string to List[float]?
        embeddings=[eval(embedding) for embedding in df.embeddings.tolist()],
        metadatas=df[metadata_list].to_dict(orient='records'),
        ids=[str(id) for id in df.message_id.tolist()],
    )

    print(f"Added word embeddings to ChromaDB collection, current collection item count {collection.count()}")
    return ''

# Allow function invocation as curl POST request and direct AWS Lambda SDK invocation
def validate_invocation_message(records):
    if len(records) != 1:
        return {"error": "No or >1 message passed to Lambda function, function only supports single message processing"}

    message = records[0]

    if 'body' not in message:
        return {"error": "No 'body' field for message"}

    event = json.loads(message['body'])
    bucket_name = event["detail"]["bucket"]["name"]
    object_key = event["detail"]["object"]["key"]

    return {
        "bucket_name": bucket_name,
        "object_key": object_key,
        "error": None
    }