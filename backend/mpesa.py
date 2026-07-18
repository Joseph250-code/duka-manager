import os
import base64
import datetime
import requests

CONSUMER_KEY = os.environ.get("MPESA_CONSUMER_KEY")
CONSUMER_SECRET = os.environ.get("MPESA_CONSUMER_SECRET")
SHORTCODE = os.environ.get("MPESA_SHORTCODE")
PASSKEY = os.environ.get("MPESA_PASSKEY")

# Sandbox base URL — switch to api.safaricom.co.ke when you go live
BASE_URL = "https://sandbox.safaricom.co.ke"

# Your backend's public URL, so Safaricom knows where to send the callback
CALLBACK_URL = "https://duka-manager.onrender.com/mpesa-callback"


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


def _generate_password_and_timestamp():
    timestamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    raw = f"{SHORTCODE}{PASSKEY}{timestamp}"
    password = base64.b64encode(raw.encode()).decode()
    return password, timestamp


def trigger_stk_push(phone_number, amount, account_reference="DukaManager"):
    """
    Sends an STK Push prompt to the customer's phone.
    phone_number must be in the format 2547XXXXXXXX (no leading 0 or +).
    Returns Safaricom's response dict, which includes CheckoutRequestID.
    """
    token = get_access_token()
    password, timestamp = _generate_password_and_timestamp()

    url = f"{BASE_URL}/mpesa/stkpush/v1/processrequest"
    headers = {"Authorization": f"Bearer {token}"}

    payload = {
        "BusinessShortCode": SHORTCODE,
        "Password": password,
        "Timestamp": timestamp,
        "TransactionType": "CustomerPayBillOnline",
        "Amount": int(amount),
        "PartyA": phone_number,
        "PartyB": SHORTCODE,
        "PhoneNumber": phone_number,
        "CallBackURL": CALLBACK_URL,
        "AccountReference": account_reference,
        "TransactionDesc": "Payment for goods"
    }

    response = requests.post(url, json=payload, headers=headers, timeout=15)
    response.raise_for_status()
    return response.json()