# Reset DB
# No CICD pipeline or external API because this is a nuclear function

__import__('pysqlite3')
import sys
sys.modules['sqlite3'] = sys.modules.pop('pysqlite3')
import chromadb
import os
import subprocess

def handler(event, context):
    print(f"Received event: {event}")

    # Input validation

    if 'operation' not in event:
        error = "Please provide 'operation' key of either 'reset' or 'delete' to Lambda invocation event"
        print(error)
        resp = {
            'statusCode': 400,
            'body': error
        }
        return resp

    operation = event['operation']

    if operation != 'reset' and operation != 'delete':
        error = "Please provide 'operation' key of either 'reset' or 'delete' to Lambda invocation event"
        print(error)
        resp = {
            'statusCode': 400,
            'body': error
        }
        return resp

    chroma_client = chromadb.PersistentClient(os.environ.get("ChromaDBLambdaMountDirectory"))

    if operation == 'delete':
        print('Deleting ChromaDB collection')
        chroma_client.delete_collection(
            name=os.environ.get("ChromaDBCollectionName")
        )
        print('Successfully deleted ChromaDB collection')

    if operation == 'reset':
        print('Resetting ChromaDB collection')
        chroma_client.reset()
        print('Successfully reset ChromaDB collection')

    print("Wiping vectorDB directory")
    bash_command = subprocess.check_output(f'rm -rf {os.environ.get("ChromaDBLambdaMountDirectory")}/*', shell=True)

    print("Wiped vectorDB directory, creating new collection")
    collection = chroma_client.get_or_create_collection(
        name=os.environ.get("ChromaDBCollectionName"),
        metadata={"hnsw:space": "cosine"}
    )
    print(f'Current collection count - {collection.count()}')

    resp = {
        'statusCode': 200,
        'body': f"Successfully ChromaDB {operation} operation"
    }
    print(resp)
    return resp