# Copyright (c) 2022, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE

import datetime
import decimal
import json
import mimetypes
import os
from typing import TYPE_CHECKING
from urllib.parse import quote

import werkzeug.utils
from werkzeug.exceptions import Forbidden, NotFound
from werkzeug.local import LocalProxy
from werkzeug.wrappers import Response
from werkzeug.wsgi import wrap_file

import frappe
import frappe.model.document
import frappe.sessions
import frappe.utils
from frappe import _
from frappe.core.doctype.access_log.access_log import make_access_log
from frappe.utils import cint, format_timedelta

if TYPE_CHECKING:
	from frappe.core.doctype.file.file import File


def report_error(status_code):
	"""Build error. Show traceback in developer mode"""
	allow_traceback = is_traceback_allowed() and (status_code != 404 or frappe.conf.logging)

	if allow_traceback:
		traceback = frappe.utils.get_traceback()
		if traceback:
			frappe.errprint(traceback)
			frappe.local.response.exception = traceback.splitlines()[-1]

	response = build_response("json")
	response.status_code = status_code
	return response


def is_traceback_allowed():
	return (
		frappe.db
		and frappe.get_system_settings("allow_error_traceback")
		and (not frappe.local.flags.disable_traceback or frappe._dev_server)
	)


def build_response(response_type=None):
	if "docs" in frappe.local.response and not frappe.local.response.docs:
		del frappe.local.response["docs"]

	response_type_map = {
		"csv": as_csv,
		"txt": as_txt,
		"download": as_raw,
		"json": as_json,
		"pdf": as_pdf,
		"page": as_page,
		"redirect": redirect,
		"binary": as_binary,
	}

	return response_type_map[frappe.response.get("type") or response_type]()


def as_csv():
	response = Response()
	response.mimetype = "text/csv"
	filename = f"{frappe.response['doctype']}.csv"
	filename = filename.encode("utf-8").decode("unicode-escape", "ignore")
	response.headers.add("Content-Disposition", "attachment", filename=filename)
	response.data = frappe.response["result"]
	return response


def as_txt():
	response = Response()
	response.mimetype = "text"
	filename = f"{frappe.response['doctype']}.txt"
	filename = filename.encode("utf-8").decode("unicode-escape", "ignore")
	response.headers.add("Content-Disposition", "attachment", filename=filename)
	response.data = frappe.response["result"]
	return response


def as_raw():
	response = Response()
	response.mimetype = (
		frappe.response.get("content_type")
		or mimetypes.guess_type(frappe.response["filename"])[0]
		or "application/unknown"
	)
	filename = frappe.response["filename"].encode("utf-8").decode("unicode-escape", "ignore")
	response.headers.add(
		"Content-Disposition",
		frappe.response.get("display_content_as", "attachment"),
		filename=filename,
	)
	response.data = frappe.response["filecontent"]
	return response


def as_json():
	make_logs()
	response = Response()
	if frappe.local.response.http_status_code:
		response.status_code = frappe.local.response["http_status_code"]
		del frappe.local.response["http_status_code"]

	response.mimetype = "application/json"
	response.data = json.dumps(frappe.local.response, default=json_handler, separators=(",", ":"))
	return response


def as_pdf():
	response = Response()
	response.mimetype = "application/pdf"
	filename = frappe.response["filename"].encode("utf-8").decode("unicode-escape", "ignore")
	response.headers.add("Content-Disposition", None, filename=filename)
	response.data = frappe.response["filecontent"]
	return response


def as_binary():
	response = Response()
	response.mimetype = "application/octet-stream"
	filename = frappe.response["filename"]
	filename = filename.encode("utf-8").decode("unicode-escape", "ignore")
	response.headers.add("Content-Disposition", None, filename=filename)
	response.data = frappe.response["filecontent"]
	return response


def make_logs(response=None):
	"""make strings for msgprint and errprint"""
	if not response:
		response = frappe.local.response

	if frappe.error_log and is_traceback_allowed():
		response["exc"] = json.dumps([frappe.utils.cstr(d["exc"]) for d in frappe.local.error_log])

	if frappe.local.message_log:
		response["_server_messages"] = json.dumps([frappe.utils.cstr(d) for d in frappe.local.message_log])

	if frappe.debug_log and frappe.conf.get("logging") or False:
		response["_debug_messages"] = json.dumps(frappe.local.debug_log)

	if frappe.flags.error_message:
		response["_error_message"] = frappe.flags.error_message


def json_handler(obj):
	"""serialize non-serializable data for json"""
	from collections.abc import Iterable
	from re import Match

	if isinstance(obj, datetime.date | datetime.datetime | datetime.time):
		return str(obj)

	elif isinstance(obj, datetime.timedelta):
		return format_timedelta(obj)

	elif isinstance(obj, decimal.Decimal):
		return float(obj)

	elif isinstance(obj, LocalProxy):
		return str(obj)

	elif isinstance(obj, frappe.model.document.BaseDocument):
		doc = obj.as_dict(no_nulls=True)
		return doc

	elif isinstance(obj, Iterable):
		return list(obj)

	elif isinstance(obj, Match):
		return obj.string

	elif type(obj) == type or isinstance(obj, Exception):
		return repr(obj)

	elif callable(obj):
		return repr(obj)

	else:
		raise TypeError(f"""Object of type {type(obj)} with value of {obj!r} is not JSON serializable""")


def as_page():
	"""print web page"""
	from frappe.website.serve import get_response

	return get_response(frappe.response["route"], http_status_code=frappe.response.get("http_status_code"))


def redirect():
	return werkzeug.utils.redirect(frappe.response.location)


def download_backup(path):
	try:
		frappe.only_for(("System Manager", "Administrator"))
		make_access_log(report_name="Backup")
	except frappe.PermissionError:
		raise Forbidden(
			_("You need to be logged in and have System Manager Role to be able to access backups.")
		)

	return send_private_file(path)


def download_private_file(path: str) -> Response:
	"""Checks permissions and sends back private file"""
	from frappe.core.doctype.file.utils import find_file_by_url

	if frappe.session.user == "Guest":
		raise Forbidden(_("You don't have permission to access this file"))

	file = find_file_by_url(path, name=frappe.form_dict.fid)
	if not file:
		raise Forbidden(_("You don't have permission to access this file"))

	make_access_log(doctype="File", document=file.name, file_type=os.path.splitext(path)[-1][1:])
	return send_private_file(path.split("/private", 1)[1])


def send_private_file(path: str) -> Response:
	path = os.path.join(frappe.local.conf.get("private_path", "private"), path.strip("/"))
	filename = os.path.basename(path)

	if frappe.local.request.headers.get("X-Use-X-Accel-Redirect"):
		path = "/protected/" + path
		response = Response()
		response.headers["X-Accel-Redirect"] = quote(frappe.utils.encode(path))

	else:
		filepath = frappe.utils.get_site_path(path)
		try:
			f = open(filepath, "rb")
		except OSError:
			raise NotFound

		response = Response(wrap_file(frappe.local.request.environ, f), direct_passthrough=True)

	# no need for content disposition and force download. let browser handle its opening.
	# Except for those that can be injected with scripts.

	extension = os.path.splitext(path)[1]
	blacklist = [".svg", ".html", ".htm", ".xml"]

	if extension.lower() in blacklist:
		response.headers.add("Content-Disposition", "attachment", filename=filename)

	response.mimetype = mimetypes.guess_type(filename)[0] or "application/octet-stream"

	return response


def handle_session_stopped():
	from frappe.website.serve import get_response

	frappe.respond_as_web_page(
		_("Updating"),
		_("The system is being updated. Please refresh again after a few moments."),
		http_status_code=503,
		indicator_color="orange",
		fullpage=True,
		primary_action=None,
	)
	return get_response("message", http_status_code=503)
