erpnext.SerialNoBatchSelector = class SerialNoBatchSelector {
	constructor(opts, show_dialog) {
		$.extend(this, opts);
		this.show_dialog = show_dialog;
		// frm, item, warehouse_details, has_batch, oldest
		let d = this.item;
		this.has_batch = 0;
		this.has_serial_no = 0;

		if (d && d.has_batch_no && (!d.batch_no || this.show_dialog)) this.has_batch = 1;
		// !(this.show_dialog == false) ensures that show_dialog is implictly true, even when undefined
		if (d && d.has_serial_no && !(this.show_dialog == false)) this.has_serial_no = 1;

		this.setup();
	}

	setup() {
		this.item_code = this.item.item_code;
		this.qty = this.item.qty;
		this.make_dialog();
		this.on_close_dialog();
	}

	make_dialog() {
		var me = this;

		this.data = this.oldest ? this.oldest : [];
		let title = "";
		let fields = [
			{
				fieldname: "item_code",
				read_only: 1,
				fieldtype: "Link",
				options: "Item",
				label: __("Item Code"),
				default: me.item_code,
			},
			{
				fieldname: "warehouse",
				fieldtype: "Link",
				options: "Warehouse",
				reqd: me.has_batch && !me.has_serial_no ? 0 : 1,
				label: __(me.warehouse_details.type),
				default: typeof me.warehouse_details.name == "string" ? me.warehouse_details.name : "",
				onchange: function (e) {
					me.warehouse_details.name = this.get_value();

					if (me.has_batch && !me.has_serial_no) {
						fields = fields.concat(me.get_batch_fields());
					} else {
						fields = fields.concat(me.get_serial_no_fields());
					}

					var batches = this.layout.fields_dict.batches;
					if (batches) {
						batches.grid.df.data = [];
						batches.grid.refresh();
						batches.grid.add_new_row(null, null, null);
					}
				},
				get_query: function () {
					return {
						query: "erpnext.controllers.queries.warehouse_query",
						filters: [
							["Bin", "item_code", "=", me.item_code],
							["Warehouse", "is_group", "=", 0],
							["Warehouse", "company", "=", me.frm.doc.company],
						],
					};
				},
			},
			{ fieldtype: "Column Break" },
			{
				fieldname: "qty",
				fieldtype: "Float",
				read_only: me.has_batch && !me.has_serial_no,
				label: __(me.has_batch && !me.has_serial_no ? "Selected Qty" : "Qty"),
				default: flt(me.item.stock_qty) || flt(me.item.transfer_qty),
			},
			...get_pending_qty_fields(me),
			{
				fieldname: "uom",
				read_only: 1,
				fieldtype: "Link",
				options: "UOM",
				label: __("UOM"),
				default: me.item.uom,
			},
			{
				fieldname: "auto_fetch_button",
				fieldtype: "Button",
				hidden: me.has_batch && !me.has_serial_no,
				label: __("Auto Fetch"),
				description: __("Fetch Serial Numbers based on FIFO"),
				click: () => {
					let qty = this.dialog.fields_dict.qty.get_value();
					let already_selected_serial_nos = get_selected_serial_nos(me);
					let numbers = frappe.call({
						method: "erpnext.stock.doctype.serial_no.serial_no.auto_fetch_serial_number",
						args: {
							qty: qty,
							item_code: me.item_code,
							warehouse:
								typeof me.warehouse_details.name == "string" ? me.warehouse_details.name : "",
							batch_nos: me.item.batch_no || null,
							posting_date: me.frm.doc.posting_date || me.frm.doc.transaction_date,
							exclude_sr_nos: already_selected_serial_nos,
						},
					});

					numbers.then((data) => {
						let auto_fetched_serial_numbers = data.message;
						let records_length = auto_fetched_serial_numbers.length;
						if (!records_length) {
							const warehouse = me.dialog.fields_dict.warehouse.get_value().bold();
							frappe.msgprint(
								__(
									"Serial numbers unavailable for Item {0} under warehouse {1}. Please try changing warehouse.",
									[me.item.item_code.bold(), warehouse]
								)
							);
						}
						if (records_length < qty) {
							frappe.msgprint(
								__("Fetched only {0} available serial numbers.", [records_length])
							);
						}
						let serial_no_list_field = this.dialog.fields_dict.serial_no;
						numbers = auto_fetched_serial_numbers.join("\n");
						serial_no_list_field.set_value(numbers);
					});
				},
			},
		];

		if (this.has_batch && !this.has_serial_no) {
			title = __("Select Batch Numbers");
			fields = fields.concat(this.get_batch_fields());
		} else {
			// if only serial no OR
			// if both batch_no & serial_no then only select serial_no and auto set batches nos
			title = __("Select Serial Numbers");
			fields = fields.concat(this.get_serial_no_fields());
		}

		this.dialog = new frappe.ui.Dialog({
			title: title,
			fields: fields,
		});

		this.dialog.set_primary_action(__("Insert"), function () {
			me.values = me.dialog.get_values();
			if (me.validate()) {
				frappe.run_serially([
					() => me.update_batch_items(),
					() => me.update_serial_no_item(),
					() => me.update_batch_serial_no_items(),
					() => {
						refresh_field("items");
						refresh_field("packed_items");
						if (me.callback) {
							return me.callback(me.item);
						}
					},
					() => me.dialog.hide(),
				]);
			}
		});

		if (this.show_dialog) {
			let d = this.item;
			if (this.item.serial_no) {
				this.dialog.fields_dict.serial_no.set_value(this.item.serial_no);
			}

			if (this.has_batch && !this.has_serial_no && d.batch_no) {
				this.frm.doc.items.forEach((data) => {
					if (data.item_code == d.item_code) {
						this.dialog.fields_dict.batches.df.data.push({
							batch_no: data.batch_no,
							actual_qty: data.actual_qty,
							selected_qty: data.qty,
							available_qty: data.actual_batch_qty,
						});
					}
				});
				this.dialog.fields_dict.batches.grid.refresh();
			}
		}

		if (this.has_batch && !this.has_serial_no) {
			this.update_total_qty();
			this.update_pending_qtys();
		}

		this.dialog.show();
	}

	on_close_dialog() {
		this.dialog.get_close_btn().on("click", () => {
			this.on_close && this.on_close(this.item);
		});
	}

	validate() {
		let values = this.values;
		if (!values.warehouse) {
			frappe.throw(__("Please select a warehouse"));
			return false;
		}
		if (this.has_batch && !this.has_serial_no) {
			if (values.batches.length === 0 || !values.batches) {
				frappe.throw(__("Please select batches for batched item {0}", [values.item_code]));
			}
			values.batches.map((batch, i) => {
				if (!batch.selected_qty || batch.selected_qty === 0) {
					if (!this.show_dialog) {
						frappe.throw(__("Please select quantity on row {0}", [i + 1]));
					}
				}
			});
			return true;
		} else {
			let serial_nos = values.serial_no || "";
			if (!serial_nos || !serial_nos.replace(/\s/g, "").length) {
				frappe.throw(__("Please enter serial numbers for serialized item {0}", [values.item_code]));
			}
			return true;
		}
	}

	update_batch_items() {
		// clones an items if muliple batches are selected.
		if (this.has_batch && !this.has_serial_no) {
			this.values.batches.map((batch, i) => {
				let batch_no = batch.batch_no;
				let row = "";

				if (i !== 0 && !this.batch_exists(batch_no)) {
					row = this.frm.add_child("items", { ...this.item });
				} else {
					row = this.frm.doc.items.find((i) => i.batch_no === batch_no);
				}

				if (!row) {
					row = this.item;
				}
				// this ensures that qty & batch no is set
				this.map_row_values(row, batch, "batch_no", "selected_qty", this.values.warehouse);
			});
		}
	}

	update_serial_no_item() {
		// just updates serial no for the item
		if (this.has_serial_no && !this.has_batch) {
			this.map_row_values(this.item, this.values, "serial_no", "qty");
		}
	}

	update_batch_serial_no_items() {
		// if serial no selected is from different batches, adds new rows for each batch.
		if (this.has_batch && this.has_serial_no) {
			const selected_serial_nos = this.values.serial_no.split(/\n/g).filter((s) => s);

			return frappe.db
				.get_list("Serial No", {
					filters: { name: ["in", selected_serial_nos] },
					fields: ["batch_no", "name"],
				})
				.then((data) => {
					// data = [{batch_no: 'batch-1', name: "SR-001"},
					// 	{batch_no: 'batch-2', name: "SR-003"}, {batch_no: 'batch-2', name: "SR-004"}]
					const batch_serial_map = data.reduce((acc, d) => {
						if (!acc[d["batch_no"]]) acc[d["batch_no"]] = [];
						acc[d["batch_no"]].push(d["name"]);
						return acc;
					}, {});
					// batch_serial_map = { "batch-1": ['SR-001'], "batch-2": ["SR-003", "SR-004"]}
					Object.keys(batch_serial_map).map((batch_no, i) => {
						let row = "";
						const serial_no = batch_serial_map[batch_no];
						if (i == 0) {
							row = this.item;
							this.map_row_values(
								row,
								{ qty: serial_no.length, batch_no: batch_no },
								"batch_no",
								"qty",
								this.values.warehouse
							);
						} else if (!this.batch_exists(batch_no)) {
							row = this.frm.add_child("items", { ...this.item });
							row.batch_no = batch_no;
						} else {
							row = this.frm.doc.items.find((i) => i.batch_no === batch_no);
						}
						const values = {
							qty: serial_no.length,
							serial_no: serial_no.join("\n"),
						};
						this.map_row_values(row, values, "serial_no", "qty", this.values.warehouse);
					});
				});
		}
	}

	batch_exists(batch) {
		const batches = this.frm.doc.items.map((data) => data.batch_no);
		return batches && in_list(batches, batch) ? true : false;
	}

	map_row_values(row, values, number, qty_field, warehouse) {
		row.qty = values[qty_field];
		row.transfer_qty = flt(values[qty_field]) * flt(row.conversion_factor);
		row[number] = values[number];
		if (this.warehouse_details.type === "Source Warehouse") {
			row.s_warehouse = values.warehouse || warehouse;
		} else if (this.warehouse_details.type === "Target Warehouse") {
			row.t_warehouse = values.warehouse || warehouse;
		} else {
			row.warehouse = values.warehouse || warehouse;
		}

		this.frm.dirty();
	}

	update_total_qty() {
		let qty_field = this.dialog.fields_dict.qty;
		let total_qty = 0;

		this.dialog.fields_dict.batches.df.data.forEach((data) => {
			total_qty += flt(data.selected_qty);
		});

		qty_field.set_input(total_qty);
	}

	update_pending_qtys() {
		const pending_qty_field = this.dialog.fields_dict.pending_qty;
		const total_selected_qty_field = this.dialog.fields_dict.total_selected_qty;

		if (!pending_qty_field || !total_selected_qty_field) return;

		const me = this;
		const required_qty = this.dialog.fields_dict.required_qty.value;
		const selected_qty = this.dialog.fields_dict.qty.value;
		const total_selected_qty = selected_qty + calc_total_selected_qty(me);
		const pending_qty = required_qty - total_selected_qty;

		pending_qty_field.set_input(pending_qty);
		total_selected_qty_field.set_input(total_selected_qty);
	}

	get_batch_fields() {
		var me = this;

		return [
			{ fieldtype: "Section Break", label: __("Batches") },
			{
				fieldname: "batches",
				fieldtype: "Table",
				label: __("Batch Entries"),
				fields: [
					{
						fieldtype: "Link",
						read_only: 0,
						fieldname: "batch_no",
						options: "Batch",
						label: __("Select Batch"),
						in_list_view: 1,
						get_query: function () {
							return {
								filters: {
									item_code: me.item_code,
									warehouse:
										me.warehouse || typeof me.warehouse_details.name == "string"
											? me.warehouse_details.name
											: "",
								},
								query: "erpnext.controllers.queries.get_batch_no",
							};
						},
						onchange: function () {
							const batch_no = this.get_value();
							if (!batch_no) {
								this.grid_row.on_grid_fields_dict.available_qty.set_value(0);
								return;
							}
							let selected_batches = this.grid.grid_rows.map((row) => {
								if (row === this.grid_row) {
									return "";
								}

								if (row.on_grid_fields_dict.batch_no) {
									return row.on_grid_fields_dict.batch_no.get_value();
								}
							});
							if (selected_batches.includes(batch_no)) {
								this.set_value("");
								frappe.throw(__("Batch {0} already selected.", [batch_no]));
							}

							if (me.warehouse_details.name) {
								frappe.call({
									method: "erpnext.stock.doctype.batch.batch.get_batch_qty",
									args: {
										batch_no,
										warehouse: me.warehouse_details.name,
										item_code: me.item_code,
									},
									callback: (r) => {
										this.grid_row.on_grid_fields_dict.available_qty.set_value(
											r.message || 0
										);
									},
								});
							} else {
								this.set_value("");
								frappe.throw(__("Please select a warehouse to get available quantities"));
							}
							// e.stopImmediatePropagation();
						},
					},
					{
						fieldtype: "Float",
						read_only: 1,
						fieldname: "available_qty",
						label: __("Available"),
						in_list_view: 1,
						default: 0,
						change: function () {
							this.grid_row.on_grid_fields_dict.selected_qty.set_value("0");
						},
					},
					{
						fieldtype: "Float",
						read_only: 0,
						fieldname: "selected_qty",
						label: __("Qty"),
						in_list_view: 1,
						default: 0,
						change: function () {
							var batch_no = this.grid_row.on_grid_fields_dict.batch_no.get_value();
							var available_qty = this.grid_row.on_grid_fields_dict.available_qty.get_value();
							var selected_qty = this.grid_row.on_grid_fields_dict.selected_qty.get_value();

							if (batch_no.length === 0 && parseInt(selected_qty) !== 0) {
								frappe.throw(__("Please select a batch"));
							}
							if (
								me.warehouse_details.type === "Source Warehouse" &&
								parseFloat(available_qty) < parseFloat(selected_qty)
							) {
								this.set_value("0");
								frappe.throw(
									__(
										"For transfer from source, selected quantity cannot be greater than available quantity"
									)
								);
							} else {
								this.grid.refresh();
							}

							me.update_total_qty();
							me.update_pending_qtys();
						},
					},
				],
				in_place_edit: true,
				data: this.data,
				get_data: function () {
					return this.data;
				},
			},
		];
	}

	get_serial_no_fields() {
		var me = this;
		this.serial_list = [];

		let serial_no_filters = {
			item_code: me.item_code,
			delivery_document_no: "",
		};

		if (this.item.batch_no) {
			serial_no_filters["batch_no"] = this.item.batch_no;
		}

		if (me.warehouse_details.name) {
			serial_no_filters["warehouse"] = me.warehouse_details.name;
		}

		if (me.frm.doc.doctype === "POS Invoice" && !this.showing_reserved_serial_nos_error) {
			frappe
				.call({
					method: "erpnext.stock.doctype.serial_no.serial_no.get_pos_reserved_serial_nos",
					args: {
						filters: {
							item_code: me.item_code,
							warehouse:
								typeof me.warehouse_details.name == "string" ? me.warehouse_details.name : "",
						},
					},
				})
				.then((data) => {
					serial_no_filters["name"] = ["not in", data.message[0]];
				});
		}

		return [
			{ fieldtype: "Section Break", label: __("Serial Numbers") },
			{
				fieldtype: "Link",
				fieldname: "serial_no_select",
				options: "Serial No",
				label: __("Select to add Serial Number."),
				get_query: function () {
					return {
						filters: serial_no_filters,
					};
				},
				onchange: function (e) {
					if (this.in_local_change) return;
					this.in_local_change = 1;

					let serial_no_list_field = this.layout.fields_dict.serial_no;
					let qty_field = this.layout.fields_dict.qty;

					let new_number = this.get_value();
					let list_value = serial_no_list_field.get_value();
					let new_line = "\n";
					if (!list_value) {
						new_line = "";
					} else {
						me.serial_list = list_value.split(/\n/g) || [];
					}

					if (!me.serial_list.includes(new_number)) {
						this.set_new_description("");
						serial_no_list_field.set_value(me.serial_list.join("\n") + new_line + new_number);
						me.serial_list = serial_no_list_field.get_value().split(/\n/g) || [];
					} else {
						this.set_new_description(new_number + " is already selected.");
					}

					me.serial_list = me.serial_list.filter((serial) => {
						if (serial) {
							return true;
						}
					});

					qty_field.set_input(me.serial_list.length);
					this.$input.val("");
					this.in_local_change = 0;
				},
			},
			{ fieldtype: "Section Break" },
			{
				fieldname: "serial_no",
				fieldtype: "Text",
				label: __(
					me.has_batch && !me.has_serial_no ? "Selected Batch Numbers" : "Selected Serial Numbers"
				),
				onchange: function () {
					me.serial_list = this.get_value().split(/\n/g);
					me.serial_list = me.serial_list.filter((serial) => {
						if (serial) {
							return true;
						}
					});

					this.layout.fields_dict.qty.set_input(me.serial_list.length);
				},
			},
		];
	}
};

function get_pending_qty_fields(me) {
	if (!check_can_calculate_pending_qty(me)) return [];
	const {
		frm: {
			doc: { fg_completed_qty },
		},
		item: { item_code, stock_qty },
	} = me;
	const { qty_consumed_per_unit } = erpnext.stock.bom.items[item_code];

	const total_selected_qty = calc_total_selected_qty(me);
	const required_qty = flt(fg_completed_qty) * flt(qty_consumed_per_unit);
	const pending_qty = required_qty - (flt(stock_qty) + total_selected_qty);

	const pending_qty_fields = [
		{ fieldtype: "Section Break", label: __("Pending Quantity") },
		{
			fieldname: "required_qty",
			read_only: 1,
			fieldtype: "Float",
			label: __("Required Qty"),
			default: required_qty,
		},
		{ fieldtype: "Column Break" },
		{
			fieldname: "total_selected_qty",
			read_only: 1,
			fieldtype: "Float",
			label: __("Total Selected Qty"),
			default: total_selected_qty,
		},
		{ fieldtype: "Column Break" },
		{
			fieldname: "pending_qty",
			read_only: 1,
			fieldtype: "Float",
			label: __("Pending Qty"),
			default: pending_qty,
		},
	];
	return pending_qty_fields;
}

// get all items with same item code except row for which selector is open.
function get_rows_with_same_item_code(me) {
	const {
		frm: {
			doc: { items },
		},
		item: { name, item_code },
	} = me;
	return items.filter((item) => item.name !== name && item.item_code === item_code);
}

function calc_total_selected_qty(me) {
	const totalSelectedQty = get_rows_with_same_item_code(me)
		.map((item) => flt(item.qty))
		.reduce((i, j) => i + j, 0);
	return totalSelectedQty;
}

function get_selected_serial_nos(me) {
	const selected_serial_nos = get_rows_with_same_item_code(me)
		.map((item) => item.serial_no)
		.filter((serial) => serial)
		.map((sr_no_string) => sr_no_string.split("\n"))
		.reduce((acc, arr) => acc.concat(arr), [])
		.filter((serial) => serial);
	return selected_serial_nos;
}

function check_can_calculate_pending_qty(me) {
	const {
		frm: { doc },
		item,
	} = me;
	const docChecks =
		doc.bom_no && doc.fg_completed_qty && erpnext.stock.bom && erpnext.stock.bom.name === doc.bom_no;
	const itemChecks =
		!!item &&
		!item.original_item &&
		erpnext.stock.bom &&
		erpnext.stock.bom.items &&
		item.item_code in erpnext.stock.bom.items;
	return docChecks && itemChecks;
}

//# sourceURL=serial_no_batch_selector.js
