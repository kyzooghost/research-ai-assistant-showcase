# Take CSV file from S3, send to text-embeddingAI model, save new CSV file to S3

import pandas as pd
import logging
from openai import OpenAI
import tiktoken
import json
import boto3
import sys

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)

logger = logging.getLogger(__name__)
tokenizer = tiktoken.get_encoding("cl100k_base")
parameter_store_client = boto3.client('ssm', region_name='us-west-2')

def is_text_encodable(message: str):
    try:
        tokenizer.encode(message)
        return True
    except Exception as e:
        logger.error(f"Cannot encode message into tokens: {message}")
        logger.error(e)
        return False

def get_sys_args():
    if len(sys.argv) != 2:
        logger.error("Usage: python3 get-embedding.py <S3_OBJECT_PATH>")
        sys.exit()

    sys_args = {
        "s3_object_path": sys.argv[1],
        "csv_file_name": sys.argv[1].split('/')[-1]
    }

    return sys_args

def init_openai_client():
    secretARN = parameter_store_client.get_parameter(Name='SecretARN')['Parameter']['Value']
    secrets_manager_client = boto3.client('secretsmanager', region_name='us-west-2')
    secret_stringified = secrets_manager_client.get_secret_value(SecretId=secretARN)['SecretString']
    secret = json.loads(secret_stringified)
    openai_client = OpenAI(api_key=secret["OPENAI_API_KEY"])
    return openai_client

def main():
    sys_args = get_sys_args()
    openai_client = init_openai_client()
    s3_client = boto3.client('s3', region_name='us-west-2')
    s3BucketName = parameter_store_client.get_parameter(Name='S3BucketName')['Parameter']['Value']
    embeddingsFolder = parameter_store_client.get_parameter(Name='EmbeddingsFolder')['Parameter']['Value']

    # Get CSV file
    s3_client.download_file(
        Bucket=s3BucketName,
        Key=sys_args["s3_object_path"],
        Filename=f'/tmp/{sys_args["csv_file_name"]}'
    )

    logger.info(f"Obtained chat messages for {sys_args['s3_object_path']}")
    raw_df = pd.read_csv(f'/tmp/{sys_args["csv_file_name"]}', index_col=0)
    df = raw_df[raw_df['text'].apply(is_text_encodable)].copy()
    df['n_tokens'] = df.text.apply(lambda x: len(tokenizer.encode(x)))
    logger.info(f"Total tokens: {df.n_tokens.sum()}")

    # Send to Embedding API
    df['embeddings'] = df.text.apply(
        lambda x: openai_client.embeddings.create(
            input=x, 
            model='text-embedding-ada-002'
        ).data[0].embedding)
    
    logger.info(f"Received text embeddings")
    
    # Upload to S3
    df.to_csv(f'/tmp/{sys_args["csv_file_name"]}-with-embeddings')

    try:
        response = s3_client.upload_file(
            Filename=f'/tmp/{sys_args["csv_file_name"]}-with-embeddings',
            Bucket=s3BucketName,
            Key=f'{embeddingsFolder}/{sys_args["csv_file_name"]}'
        )
        logger.info(f'Saved embeddings to S3 bucket - {s3BucketName}/{embeddingsFolder}/{sys_args["csv_file_name"]}')
    except Exception as e:
        logger.error(e)

if __name__ == '__main__':
    main()