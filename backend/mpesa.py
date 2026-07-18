import os
import base64
import requests

CONSUMER_KEY = os.environ.get("MPESA_CONSUMER_KEY")
CONSUMER_SECRET = os.environ.get("MPESA_CONSUMER_SECRET")

# Sandbox base URL — switch to api.safaricom.co.ke when you go live
BASE_URL = "https://sandbox.safaricom.co.ke"


def get_access_token():
    """Fetch a fresh OAuth access token from Safaricom's Daraja API."""
    url = f"{BASE_URL}/oauth/v1/generate?grant_type=client_credentials"

    response = requests.get(
        url,
        auth=(CONSUMER_KEY, CONSUMER_SECRET),
        timeout=10
    )
    response.raise_for_status()

    data = response.json()
    return data["access_token"]