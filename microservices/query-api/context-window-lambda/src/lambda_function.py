# Embedding CSV on S3 -> ChromaDB storage on EFS
__import__('pysqlite3')
import sys
sys.modules['sqlite3'] = sys.modules.pop('pysqlite3')
import chromadb
import os
import json

'''
    Example event

    {
        "query_embedding": [0.0038016894832253456, -0.013051790185272694, ...],
        "filters": {
            "minimum_date": 1,
            "contains_text": ["DEX", "bro", "gpt"]
        }
    }

'''

def handler(event, context):
    print(f"Received event: {event}")

    # Input validation
    if event.get('query_embedding') is None:
        resp = {
            'statusCode': 400,
            'body': 'Missing query_embedding'
        }
        print(resp)
        return resp
    if event.get('filters') is None:
        resp = {
            'statusCode': 400,
            'body': 'Missing filters'
        }
        print(resp)
        return resp
    
    context_window = get_context_window(event['query_embedding'], event['filters'])
    print(f'context_window: {context_window}')

    resp = {
        'statusCode': 200,
        'body': context_window
    }
    print(resp)
    return resp

def get_context_window(query_embedding, filters):
    chroma_client = chromadb.PersistentClient(os.environ.get("ChromaDBLambdaMountDirectory"))

    collection = chroma_client.get_or_create_collection(
        name=os.environ.get("ChromaDBCollectionName"),
        metadata={"hnsw:space": "cosine"}
    )

    # { "documents": List[str], "metadatas": List[Dict[str, Any]]}
    chroma_query = collection.query(
        query_embeddings=query_embedding,
        n_results=get_n_results(),
        where=get_where(filters),
        where_document=get_where_document(filters),
    )
    print(f'chroma_query: {chroma_query}')

    context_window = []
    current_window_tokens = 0

    for document, metadata in zip(chroma_query['documents'][0], chroma_query['metadatas'][0]):
        current_window_tokens += int(metadata['n_tokens']) + 4
        if current_window_tokens > int(os.environ.get("ContextWindowTokenLength")):
            break
        context_window.append(document)

    return "\n".join(context_window)

def get_n_results():
    context_window_token_length = int(os.environ.get("ContextWindowTokenLength"))
    # Start with static value of 40, could implement a 'smarter dynamic' metric later
    token_length_per_message = int(os.environ.get("TokensPerMessage"))
    return int(context_window_token_length / token_length_per_message)

'''
    Filter by metadata

    {
        "metadata_field": {
            <Operator>: <Value>
        }
    }

    Shorthand for $eq

    {
        "metadata_field": "search_string"
    }
'''
def get_where(filters):
    where_candidate = {}

    if 'minimum_date' in filters:
        where_candidate['date'] = {'$gte': int(filters['minimum_date'])}

    if 'chat_id' in filters:
        where_candidate['chat_id'] = filters['chat_id']

    if 'user_id' in filters:
        where_candidate['user_id'] = filters['user_id']

    if 'medium' in filters:
        where_candidate['medium'] = filters['medium']

    if 'user_name' in filters:
        where_candidate['user_name'] = filters['user_name']

    if 'guild_id' in filters:
        where_candidate['guild_id'] = filters['guild_id']

    print(f'where_candidate: {where_candidate}')

    if (len(where_candidate) == 0):
        return None
    elif (len(where_candidate) == 1):
        return where_candidate
    else:
        where = {}
        where['$and'] = []
        for key, value in where_candidate.items():
            where['$and'].append({key: value})
        print(f'where - {where}')
        return where

# https://docs.trychroma.com/usage-guide
# Filter by text content
def get_where_document(filters):
    where_document = {}

    if 'contains_text' in filters:
        contains_text = filters['contains_text']
        # json.loads is very particular about string array format - must be '["tao", "TAO"]' and not "['tao', 'TAO']", json.dumps will do this for us
        contains_text_collection = json.loads(json.dumps(contains_text))
        if len(contains_text_collection) == 0:
            where_document = None
        elif (len(contains_text_collection) == 1):
            where_document['$contains'] = contains_text_collection[0]
        else:
            where_document['$or'] = []
            for text in contains_text_collection:
                where_document['$or'].append({'$contains': text})

    '''
                "$or": [
                    {
                        "$contains": "tao"
                    },
                    {
                        "$contains": "TAO"
                    }
                ]
    '''

    print(f'where_document: {where_document}')
    if not where_document:
        return None
    return where_document