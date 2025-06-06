# Copyright (c) 2020, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE

from collections.abc import Callable
from datetime import datetime
from functools import wraps

from werkzeug.wrappers import Response

import frappe
from frappe import _
from frappe.utils import cint


def apply():
	rate_limit = frappe.conf.rate_limit
	if rate_limit:
		frappe.local.rate_limiter = RateLimiter(rate_limit["limit"], rate_limit["window"])
		frappe.local.rate_limiter.apply()


def update():
	if hasattr(frappe.local, "rate_limiter"):
		frappe.local.rate_limiter.update()


def respond():
	if hasattr(frappe.local, "rate_limiter"):
		return frappe.local.rate_limiter.respond()


class RateLimiter:
	def __init__(self, limit, window):
		self.limit = int(limit * 1000000)
		self.window = window

		self.start = datetime.utcnow()
		timestamp = int(frappe.utils.now_datetime().timestamp())

		self.window_number, self.spent = divmod(timestamp, self.window)
		self.key = frappe.cache().make_key(f"rate-limit-counter-{self.window_number}")
		self.counter = cint(frappe.cache().get(self.key))
		self.remaining = max(self.limit - self.counter, 0)
		self.reset = self.window - self.spent

		self.end = None
		self.duration = None
		self.rejected = False

	def apply(self):
		if self.counter > self.limit:
			self.rejected = True
			self.reject()

	def reject(self):
		raise frappe.TooManyRequestsError

	def update(self):
		self.end = datetime.utcnow()
		self.duration = int((self.end - self.start).total_seconds() * 1000000)

		pipeline = frappe.cache().pipeline()
		pipeline.incrby(self.key, self.duration)
		pipeline.expire(self.key, self.window)
		pipeline.execute()

	def headers(self):
		headers = {
			"X-RateLimit-Reset": self.reset,
			"X-RateLimit-Limit": self.limit,
			"X-RateLimit-Remaining": round(self.remaining, -6),
		}
		if self.rejected:
			headers["Retry-After"] = self.reset

		return headers

	def respond(self):
		if self.rejected:
			return Response(_("Too Many Requests"), status=429)


def rate_limit(
	key: str | None = None,
	limit: int | Callable = 5,
	seconds: int = 24 * 60 * 60,
	methods: str | list = "ALL",
	ip_based: bool = True,
):
	"""Decorator to rate limit an endpoint.

	This will limit Number of requests per endpoint to `limit` within `seconds`.
	Uses redis cache to track request counts.

	:param key: Key is used to identify the requests uniqueness (Optional)
	:param limit: Maximum number of requests to allow with in window time
	:type limit: Callable or Integer
	:param seconds: window time to allow requests
	:param methods: Limit the validation for these methods.
	        `ALL` is a wildcard that applies rate limit on all methods.
	:type methods: string or list or tuple
	:param ip_based: flag to allow ip based rate-limiting
	:type ip_based: Boolean

	:returns: a decorator function that limit the number of requests per endpoint
	"""

	def ratelimit_decorator(fun):
		@wraps(fun)
		def wrapper(*args, **kwargs):
			# Do not apply rate limits if method is not opted to check
			if (
				methods != "ALL"
				and frappe.request
				and frappe.request.method
				and frappe.request.method.upper() not in methods
			):
				return frappe.call(fun, **frappe.form_dict or kwargs)

			_limit = limit() if callable(limit) else limit

			ip = frappe.local.request_ip if ip_based is True else None

			user_key = frappe.form_dict.get(key, "")

			identity = None

			if key and ip_based:
				identity = ":".join([ip, user_key])

			identity = identity or ip or user_key

			if not identity:
				frappe.throw(_("Either key or IP flag is required."))

			cache_key = frappe.cache().make_key(f"rl:{frappe.form_dict.cmd}:{identity}")

			value = frappe.cache().get(cache_key) or 0
			if not value:
				frappe.cache().setex(cache_key, seconds, 0)

			value = frappe.cache().incrby(cache_key, 1)
			if value > _limit:
				frappe.throw(
					_("You hit the rate limit because of too many requests. Please try after sometime."),
					frappe.RateLimitExceededError,
				)

			return frappe.call(fun, **frappe.form_dict or kwargs)

		return wrapper

	return ratelimit_decorator
